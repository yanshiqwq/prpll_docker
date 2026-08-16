/**
 * SQLite 持久化层（Node 24 内置 node:sqlite，零 npm 依赖）
 *
 * 职责：
 *  1. 将 PRPLL(gpuowl-*.log) 解析出的进度/速度点持久化，避免日志滚动或
 *     尾部读取窗口（8MB）导致的历史数据丢失。
 *  2. 首次运行时回溯导入当前日志中已有的全部历史点。
 *  3. 提供按时间范围 / 指数查询历史点的接口。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { GPUOWL_PROGRESS_RE, GPUOWL_CERT_PROGRESS_RE, parseGpuowlTs } = require('./gpuowl-parse');

/** 解析单行进度日志 -> 进度点（行格式不合法时返回 null） */
function parseProgressLine(line, worker) {
  let p = GPUOWL_PROGRESS_RE.exec(line);
  let isCert = false;
  if (!p) {
    p = GPUOWL_CERT_PROGRESS_RE.exec(line);
    isCert = !!p;
  }
  if (!p) return null;
  const exp = parseInt(p[3], 10);
  const iteration = parseInt(p[4], 10);
  const total = isCert ? parseInt(p[5], 10) : 0;
  const us = parseInt(isCert ? p[7] : p[6], 10);
  const ts = parseGpuowlTs(`${p[1]} ${p[2]}`);
  if (ts == null || !exp || !iteration) return null;
  return {
    ts,
    worker,
    exponent: exp,
    iteration,
    percent: total > 0 ? (iteration / total) * 100 : (iteration / exp) * 100,
    usPerIter: us > 0 ? us : null,
    itersPerSec: us > 0 ? 1e6 / us : null,
  };
}

class HistoryDB {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.db = null;
  }

  /** 打开数据库并建表（幂等） */
  init() {
    try {
      fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    } catch (e) { /* 已存在 */ }
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;

      CREATE TABLE IF NOT EXISTS prp_points (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,             -- epoch 毫秒
        worker INTEGER NOT NULL,
        exponent INTEGER NOT NULL,
        iteration INTEGER NOT NULL,
        percent REAL,
        us_per_iter INTEGER,
        iters_per_sec REAL
      );
      CREATE INDEX IF NOT EXISTS idx_prp_points_ts ON prp_points(ts);
      CREATE INDEX IF NOT EXISTS idx_prp_points_worker_ts ON prp_points(worker, ts);
      CREATE INDEX IF NOT EXISTS idx_prp_points_exp_ts ON prp_points(exponent, ts);
      -- 幂等导入：同一点重复扫描时跳过（解析器升级后可安全全量回扫）
      CREATE UNIQUE INDEX IF NOT EXISTS idx_prp_points_unique ON prp_points(ts, worker, exponent, iteration);

      -- 每个日志文件的增量导入游标：记录已处理的字节偏移
      CREATE TABLE IF NOT EXISTS import_cursor (
        file TEXT PRIMARY KEY,
        offset INTEGER NOT NULL DEFAULT 0,
        size INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL DEFAULT 0
      );
    `);
    return this;
  }

  /** 获取某文件的导入游标；不存在返回 null */
  getCursor(file) {
    if (!this.db) return null;
    const row = this.db.prepare('SELECT offset, size FROM import_cursor WHERE file = ?').get(file);
    return row || null;
  }

  /** 更新（或插入）导入游标 */
  setCursor(file, offset, size) {
    if (!this.db) return;
    this.db
      .prepare(
        `INSERT INTO import_cursor(file, offset, size, updated_at) VALUES(?, ?, ?, ?)
         ON CONFLICT(file) DO UPDATE SET offset = excluded.offset, size = excluded.size, updated_at = excluded.updated_at`
      )
      .run(file, offset, size, Date.now());
  }

  /** 批量写入进度点 */
  insertPoints(rows) {
    if (!this.db || !rows.length) return;
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO prp_points(ts, worker, exponent, iteration, percent, us_per_iter, iters_per_sec)
       VALUES(?, ?, ?, ?, ?, ?, ?)`
    );
    this.db.exec('BEGIN');
    try {
      for (const r of rows) {
        stmt.run(r.ts, r.worker, r.exponent, r.iteration, r.percent, r.usPerIter, r.itersPerSec);
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /**
   * 增量导入某个 gpuowl 日志文件。
   * 只在文件增大时解析新增字节；文件被截断/轮转时从开头重新扫描。
   * @param {boolean} [forceFull] 为 true 时强制全量扫描（忽略游标，用于初次回溯导入）
   * @returns 本次导入的点数
   */
  importLog(file, worker, forceFull = false) {
    if (!this.db) return 0;
    const filePath = path.join(this.dataDir || '', file);
    let size;
    try {
      size = fs.statSync(filePath).size;
    } catch (e) {
      return 0; // 文件不存在
    }
    const cursor = this.getCursor(file);
    // 强制全量 / 游标不存在（首次）/ 文件被截断或轮转时从 0 开始
    const start = forceFull || (cursor && size >= cursor.offset ? cursor.offset : 0);
    if (start === size && !forceFull) return 0; // 无新增
    const readStart = forceFull ? 0 : start;

    // 分块读取，避免超大日志一次性载入内存
    const rows = [];
    const CHUNK = 1024 * 1024; // 1MB
    const fd = fs.openSync(filePath, 'r');
    let pos = readStart;
    let pending = ''; // 跨块的行缓冲
    while (pos < size) {
      const len = Math.min(CHUNK, size - pos);
      const buf = Buffer.alloc(len);
      let off = 0;
      while (off < len) {
        const n = fs.readSync(fd, buf, off, len - off, pos + off);
        if (n <= 0) break;
        off += n;
      }
      pos += off;
      pending += buf.toString('utf8', 0, off);
      let nl;
      while ((nl = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, nl);
        pending = pending.slice(nl + 1);
        if (line) {
          const row = parseProgressLine(line, worker);
          if (row) rows.push(row);
        }
      }
    }
    fs.closeSync(fd);
    // 最后一段无换行符的残留内容也尝试解析（可能是被截断的完整行）
    if (pending) {
      const row = parseProgressLine(pending, worker);
      if (row) rows.push(row);
    }

    if (rows.length) this.insertPoints(rows);
    this.setCursor(file, size, size);
    return rows.length;
  }

  /** 是否已初始化（存在任意已导入的进度点） */
  isInitialized() {
    if (!this.db) return false;
    const row = this.db.prepare('SELECT COUNT(*) AS c FROM prp_points').get();
    return row && row.c > 0;
  }

  /** 遍历 dataDir 下所有 gpuowl-*.log，执行一次全量回溯导入（忽略游标） */
  fullImportAll() {
    if (!this.db) return { files: 0, points: 0 };
    let files = 0;
    let points = 0;
    let logs;
    try {
      logs = fs.readdirSync(this.dataDir || '.').filter((f) => /^gpuowl-(\d+)\.log$/.test(f)).sort();
    } catch (e) {
      return { files: 0, points: 0 };
    }
    for (const f of logs) {
      const m = /^gpuowl-(\d+)\.log$/.exec(f);
      const worker = parseInt(m[1], 10);
      try {
        const n = this.importLog(f, worker, true);
        if (n > 0) files++;
        points += n;
      } catch (e) {
        console.error(`[db] 全量导入 ${f} 失败:`, e.message);
      }
    }
    return { files, points };
  }

  /**
   * 查询历史点。
   * @param {object} opts { worker, exponent?, sinceMs?, untilMs?, limit? }
   * @returns Array<[tsEpoch, value, exponent]>（value 为 percent 或 iters_per_sec）
   */
  queryPoints(opts, metric) {
    if (!this.db) return [];
    const { worker = 0, exponent = null, sinceMs = null, untilMs = null, limit = 600 } = opts;
    let sql = `SELECT ts, exponent, percent, iters_per_sec FROM prp_points WHERE worker = ?`;
    const args = [worker];
    if (exponent != null) {
      sql += ` AND exponent = ?`;
      args.push(exponent);
    }
    if (sinceMs != null) {
      sql += ` AND ts >= ?`;
      args.push(sinceMs);
    }
    if (untilMs != null) {
      sql += ` AND ts <= ?`;
      args.push(untilMs);
    }
    // 等距采样（按指数分组）：长 PRP 任务不会把短任务（如 CERT）的点稀释到不足 2 个，
    // 保证每个任务在图表上都能画出折线；总量仍受 limit 预算约束。
    const cap = Math.max(limit * 4, 5000);
    sql += ` ORDER BY ts DESC LIMIT ?`;
    args.push(cap);
    const stmt = this.db.prepare(sql);
    const all = stmt.all(...args).reverse(); // 转回时间升序

    const groups = new Map();
    for (const r of all) {
      const v = metric === 'speed' ? r.iters_per_sec : r.percent;
      if (v == null) continue;
      const pt = [r.ts, v, r.exponent];
      const list = groups.get(r.exponent) || [];
      list.push(pt);
      groups.set(r.exponent, list);
    }
    const out = [];
    const maxPerExp = Math.max(10, Math.floor(limit / Math.max(1, groups.size)));
    for (const list of groups.values()) {
      const sampled = list.length <= maxPerExp ? list : this.sample(list, maxPerExp);
      out.push(...sampled);
    }
    out.sort((a, b) => a[0] - b[0]);
    return out;
  }

  /** 等距采样，最多 limit 点，保留首尾 */
  sample(points, limit) {
    if (points.length <= limit || limit < 2) return points;
    const step = (points.length - 1) / (limit - 1);
    const out = [];
    for (let i = 0; i < limit; i++) {
      out.push(points[Math.round(i * step)]);
    }
    out[limit - 1] = points[points.length - 1];
    return out;
  }

  /** 数据范围统计（用于校验/日志） */
  stats() {
    if (!this.db) return null;
    const row = this.db.prepare('SELECT COUNT(*) AS count, MIN(ts) AS minTs, MAX(ts) AS maxTs FROM prp_points').get();
    return row;
  }

  close() {
    if (this.db) {
      try { this.db.close(); } catch (e) { /* ignore */ }
      this.db = null;
    }
  }
}

/** 创建并初始化历史数据库实例 */
function createHistoryDB(dbPath, dataDir) {
  const h = new HistoryDB(dbPath);
  h.dataDir = dataDir || path.dirname(dbPath);
  h.init();
  return h;
}

module.exports = { createHistoryDB };
