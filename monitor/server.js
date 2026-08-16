#!/usr/bin/env node
/**
 * GIMPS 监控中心后端（零依赖 Node.js）
 *
 * 读取 data/ 目录下 PRPLL(gpuowl) 与 AutoPrimeNet 的日志 / 工作文件，
 * 提供 JSON API、静态文件服务，并通过 SSE 实时推送日志。
 *
 * 环境变量：
 *   DATA_DIR  数据目录（默认 ../data，相对本文件）
 *   PORT      监听端口（默认 8080）
 *   HOST      监听地址（默认 0.0.0.0）
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const mersenne = require('./mersenne');
const tasks = require('./tasks');
const { createHistoryDB } = require('./db');
const { GPUOWL_PROGRESS_RE, GPUOWL_CERT_PROGRESS_RE, parseGpuowlTs } = require('./gpuowl-parse');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const VENDOR_DIR = path.join(ROOT, 'vendor');
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, '..', 'data'));
const PORT = parseInt(process.env.PORT || '8080', 10);
const HOST = process.env.HOST || '0.0.0.0';
const HISTORY_DB_PATH = path.join(DATA_DIR, 'monitor.sqlite');
// 控制接口访问令牌：设置 MONITOR_TOKEN 后，所有 POST /api/* 写操作必须携带 x-auth-token 头。
// 默认不开启（保持前端开箱即用），但会打印安全提醒；建议在暴露到公网/局域网时设置。
// 前端如需携带 token，可在页面加载后给所有 fetch 注入 x-auth-token 头（app.js 中实现）。
const AUTH_TOKEN = process.env.MONITOR_TOKEN && process.env.MONITOR_TOKEN !== 'none' ? process.env.MONITOR_TOKEN : '';
if (!AUTH_TOKEN) {
  console.log('[monitor] 警告：未设置 MONITOR_TOKEN，写接口（取消/暂停/导入/改设置）无鉴权保护。');
  console.log('[monitor] 若面板暴露到不可信网络，请设置环境变量 MONITOR_TOKEN 并同步配置前端。');
} else if (AUTH_TOKEN === 'none') {
  console.log('[monitor] MONITOR_TOKEN=none，写接口鉴权已显式关闭。');
} else {
  console.log('[monitor] 写接口鉴权已启用（MONITOR_TOKEN 已设置）。');
}

// 历史数据持久化（SQLite，Node 24 内置 node:sqlite）
// 初始化失败直接抛出错误，让进程以非零退出码退出（不静默回退）
const historyDb = createHistoryDB(HISTORY_DB_PATH, DATA_DIR);
console.log(`[monitor] 历史数据库已就绪: ${HISTORY_DB_PATH}`);

const LOG_NAME_RE = /^(gpuowl-\d+\.log|autoprimenet\.log)$/;
const MAX_TAIL_BYTES = 8 * 1024 * 1024; // 最多读取 8MB 尾部用于解析
const MAX_LOG_LINES = 1000;             // /api/log 默认最多返回行数
const APN_SCAN_BYTES = 2 * 1024 * 1024; // 全文件扫描 AutoPrimeNet 版本/目录行的最大字节数
const APN_PARSE_TAIL_LINES = 400;       // AutoPrimeNet 逐行解析的尾部行数
const INI_MAX_BYTES = 64 * 1024;        // prime.ini 读取上限
const RESULTS_MAX_BYTES = 16 * 1024 * 1024; // results-*.txt 读取上限
const RECENT_RESULTS = 20;              // /api/status 返回的最近结果条数

// ---------------------------------------------------------------- 小工具

const pad = (n, w = 2) => String(n).padStart(w, '0');

function fmtDateTime(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function fmtDuration(sec) {
  sec = Math.max(0, Math.round(sec));
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const parts = [];
  if (d) parts.push(`${d} 天`);
  if (h) parts.push(`${h} 小时`);
  if (m) parts.push(`${m} 分`);
  if (s && !d) parts.push(`${s} 秒`);
  return parts.join(' ') || '0 秒';
}

/** 解析 "2026-08-13 17:43:02" -> epoch 毫秒 */
function parseIsoTs(str) {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(str);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number);
  return new Date(y, mo - 1, d, h, mi, s).getTime();
}

/** 解析 gpuowl ETA："08:55" / "1d 01:01" -> 秒 */
function parseEta(text) {
  if (!text) return null;
  text = text.trim();
  const m = /^(?:(\d+)d\s+)?(\d{2}):(\d{2})$/.exec(text);
  if (!m) return null;
  return (+(m[1] || 0)) * 86400 + (+m[2]) * 3600 + (+m[3]) * 60;
}

/** 从文件读取尾部内容；文件不存在返回 null */
function tailFile(filePath, maxBytes = MAX_TAIL_BYTES) {
  try {
    const st = fs.statSync(filePath);
    const size = st.size;
    let start = 0;
    if (size > maxBytes) {
      const fd = fs.openSync(filePath, 'r');
      const buf = Buffer.alloc(maxBytes);
      const read = fs.readSync(fd, buf, 0, maxBytes, size - maxBytes);
      fs.closeSync(fd);
      return { text: buf.toString('utf8', 0, read), size, mtimeMs: st.mtimeMs, truncated: true };
    }
    return { text: fs.readFileSync(filePath, 'utf8'), size, mtimeMs: st.mtimeMs, truncated: false };
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

function safeReadLines(filePath, maxBytes) {
  const t = tailFile(filePath, maxBytes);
  if (!t) return null;
  let text = t.text;
  if (t.truncated) {
    // 截断时丢弃第一行不完整内容
    text = text.slice(text.indexOf('\n') + 1);
  }
  return {
    lines: text.split('\n').filter((l) => l.length > 0),
    size: t.size,
    mtimeMs: t.mtimeMs,
  };
}

function fileInfo(name) {
  const p = path.join(DATA_DIR, name);
  try {
    const st = fs.statSync(p);
    return { name, size: st.size, mtime: st.mtimeMs, exists: true };
  } catch (e) {
    return { name, size: 0, mtime: 0, exists: false };
  }
}

/** 等距采样，最多 N 个点，保留首尾 */
function sample(points, n) {
  if (points.length <= n || n < 2) return points;
  const step = (points.length - 1) / (n - 1);
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(points[Math.round(i * step)]);
  }
  out[n - 1] = points[points.length - 1];
  return out;
}

// ---------------------------------------------------------------- PRPLL 解析

/** 按文件 stat 做缓存的工具：文件未变化时复用解析结果 */
const fileCache = new Map();

function cachedParse(key, files, fn) {
  const sig = files
    .map((f) => {
      try {
        const st = fs.statSync(path.join(DATA_DIR, f));
        return `${f}:${st.size}:${st.mtimeMs}`;
      } catch (e) {
        return `${f}:missing`;
      }
    })
    .join('|');
  const cur = fileCache.get(key);
  if (cur && cur.sig === sig) return cur.data;
  const data = fn();
  fileCache.set(key, { sig, data });
  return data;
}

/** 补全随时间变化的字段（日志年龄、状态、ETA 时刻等），每次请求都重新计算 */
function finalizeWorker(w) {
  const nowMs = Date.now();
  const lastLogAgoSec = Math.max(0, (nowMs - w.lastLogAt) / 1000);
  let status = 'stopped';
  let statusNote = '未检测到日志';
  if (w.lastLogAt) {
    if (w.lastLineIsBye) {
      // 日志末尾是 Bye：进程已退出（崩溃或正常停止），容器很可能正在重启
      status = 'stopped';
      statusNote =
        w.restartCountRecent >= 3
          ? `进程反复崩溃退出（近 10 分钟 ${w.restartCountRecent} 次），请检查日志/任务文件`
          : '进程已退出（日志末尾为 Bye）';
    } else if (w.restartCountRecent >= 3) {
      status = 'warning';
      statusNote = `检测到反复重启（近 10 分钟 ${w.restartCountRecent} 次），请检查日志/任务文件`;
    } else if (lastLogAgoSec < 10 * 60) {
      status = 'running';
      statusNote = `最后日志 ${fmtDuration(lastLogAgoSec)} 前`;
    } else if (lastLogAgoSec < 60 * 60) {
      status = 'warning';
      statusNote = `最后日志 ${fmtDuration(lastLogAgoSec)} 前，可能已卡住`;
    } else {
      status = 'stopped';
      statusNote = `最后日志 ${fmtDuration(lastLogAgoSec)} 前`;
    }
  }
  return {
    ...w,
    status,
    statusNote,
    running: status === 'running',
    lastLogAgoSec: Math.round(lastLogAgoSec),
    sessionSinceSec: w.sessionStartAt ? Math.max(0, (nowMs - w.sessionStartAt) / 1000) : null,
    etaAt: w.etaSec != null ? Math.round(nowMs + w.etaSec * 1000) : null,
  };
}

/**
 * 解析单个 gpuowl-N.log
 */
function parseGpuowlLog(name) {
  const filePath = path.join(DATA_DIR, name);
  const data = safeReadLines(filePath);
  if (!data) return null;

  const worker = { worker: 0 };
  const m = /^gpuowl-(\d+)\.log$/.exec(name);
  if (m) worker.worker = parseInt(m[1], 10);

  const lines = data.lines;
  const lastIdx = lines.length - 1;

  // 找最近一次启动标记，确定当前会话
  let sessionStartIdx = -1;
  let sessionStartAt = null;
  let startCount = 0;
  for (let i = lastIdx; i >= 0; i--) {
    const st = /PRPLL (\S+) starting/.exec(lines[i]);
    if (st) {
      sessionStartIdx = i;
      const ts = parseGpuowlTs(lines[i].slice(0, 17));
      sessionStartAt = ts;
      break;
    }
  }
  for (const line of lines) {
    if (/PRPLL \S+ starting/.test(line)) startCount++;
  }

  // 近 10 分钟内的启动次数（覆盖整个尾部窗口，用于识别崩溃循环）
  let restartCountRecent = 0;
  const RECENT_WINDOW_MS = 10 * 60 * 1000;
  const nowMs = Date.now();
  for (const line of lines) {
    if (/PRPLL \S+ starting/.test(line)) {
      const m = /^(\d{8} \d{2}:\d{2}:\d{2})/.exec(line);
      const ts = m ? parseGpuowlTs(m[1]) : null;
      if (ts && nowMs - ts < RECENT_WINDOW_MS) restartCountRecent++;
    }
  }

  const session = sessionStartIdx >= 0 ? lines.slice(sessionStartIdx) : lines;

  let version = null;
  let device = null;
  let fft = null;
  let proofPower = null;
  let lastProgress = null;   // 最近一条进度/OK 行
  let lastOk = null;         // 最近 OK 行
  let currentExponent = null;
  let byeCount = 0;           // 当前会话内崩溃退出（Bye）次数
  const warnings = [];
  const progressHistory = []; // [tsEpoch, percent]
  const speedHistory = [];    // [tsEpoch, itersPerSec]

  for (const line of session) {
    const tsMatch = /^(\d{8} \d{2}:\d{2}:\d{2})/.exec(line);
    const ts = tsMatch ? parseGpuowlTs(tsMatch[1]) : null;

    if (/PRPLL (\S+) starting/.test(line)) {
      version = /PRPLL (\S+) starting/.exec(line)[1];
      continue;
    }
    if (/^\d{8} \d{2}:\d{2}:\d{2}\s+Bye\s*$/.test(line)) {
      byeCount++;
      continue;
    }
    if (!ts) continue;

    // PRPLL 输出形如 "device 0, OpenCL CUDA 13.3, unique id ''"，去掉无意义的 unique id 尾巴
    const deviceM = /device \d+, (.+?)(?:, unique id.*)?$/.exec(line);
    if (deviceM) {
      device = deviceM[1].trim();
      continue;
    }

    const fftM = /^(\d{8} \d{2}:\d{2}:\d{2}) (\d+) FFT: (.+)$/.exec(line);
    if (fftM) {
      fft = fftM[3];
      continue;
    }

    const proofM = /Proof of power (\d+)/.exec(line);
    if (proofM) {
      proofPower = parseInt(proofM[1], 10);
      continue;
    }

    const p = GPUOWL_PROGRESS_RE.exec(line);
    if (p) {
      const exp = parseInt(p[3], 10);
      const iteration = parseInt(p[4], 10);
      const us = parseInt(p[6], 10);
      const isOk = / OK /.test(line);
      const etaM = /ETA ([^;]+)/.exec(line);
      const zM = /Z=(\d+)/.exec(line);
      const avgM = /avg ([\d.]+)/.exec(line);

      if (exp !== currentExponent) {
        currentExponent = exp;
        // 换任务后 FFT 等信息可能变化，保留但以最新为准
      }

      lastProgress = {
        ts,
        exponent: exp,
        iteration,
        usPerIter: us,
        ok: isOk,
        etaSec: etaM ? parseEta(etaM[1]) : null,
        etaText: etaM ? etaM[1].trim() : null,
        z: zM ? parseInt(zM[1], 10) : null,
        avg: avgM ? parseFloat(avgM[1]) : null,
      };
      if (isOk) lastOk = lastProgress;

      // 历史点（按当前指数），三元组 [ts, value, exponent] 便于按任务分段上色
      if (currentExponent) {
        progressHistory.push([ts, (iteration / exp) * 100, exp]);
        if (us > 0) speedHistory.push([ts, 1e6 / us, exp]);
      }
      continue;
    }

    const cp = GPUOWL_CERT_PROGRESS_RE.exec(line);
    if (cp) {
      const exp = parseInt(cp[3], 10);
      const iteration = parseInt(cp[4], 10);
      const total = parseInt(cp[5], 10);
      const us = parseInt(cp[7], 10);
      const etaM = /ETA ([^;]+)/.exec(line);

      if (exp !== currentExponent) {
        currentExponent = exp;
        // 换任务后 FFT 等信息可能变化，保留但以最新为准
      }

      lastProgress = {
        ts,
        exponent: exp,
        iteration,
        total,
        usPerIter: us,
        ok: total > 0 && iteration >= total,
        etaSec: etaM ? parseEta(etaM[1]) : null,
        etaText: etaM ? etaM[1].trim() : null,
        z: null,
        avg: null,
      };
      // 证书验证完成行（迭代 == 总数）也记入"最近校验"
      if (lastProgress.ok) lastOk = lastProgress;

      // 历史点（按当前指数），CERT 以 squarings 总数计算百分比
      if (currentExponent) {
        progressHistory.push([ts, total > 0 ? (iteration / total) * 100 : 0, exp]);
        if (us > 0) speedHistory.push([ts, 1e6 / us, exp]);
      }
      continue;
    }

    // 告警 / 错误行（结果 JSON 行含 "error-code"/"errors" 字段，需排除）
    if (
      /(WARNING|ERROR|error|stuck|abort|restarting)/i.test(line) &&
      !/^.*\{"/.test(line) &&
      !/"exponent":\d+/.test(line)
    ) {
      warnings.push(line);
    }
  }

  const lastLine = lines[lastIdx];
  const lastLogAt = parseGpuowlTs(lastLine ? lastLine.slice(0, 17) : '') || data.mtimeMs;
  const lastLineIsBye = /^\d{8} \d{2}:\d{2}:\d{2}\s+Bye\s*$/.test(lastLine || '');

  // 当前任务信息
  let exponent = lastProgress ? lastProgress.exponent : null;
  let iteration = lastProgress ? lastProgress.iteration : null;
  let usPerIter = lastProgress ? lastProgress.usPerIter : null;
  const total = lastProgress ? lastProgress.total : null;
  const progressTotal = total || exponent;
  const percent = iteration != null && progressTotal ? (iteration / progressTotal) * 100 : null;
  const itersPerSec = usPerIter ? 1e6 / usPerIter : null;
  const percentPerDay =
    usPerIter && progressTotal ? ((86400e6 / usPerIter) / progressTotal) * 100 : null;
  const remaining = iteration != null && progressTotal ? progressTotal - iteration : null;
  const etaSec = usPerIter && remaining ? (remaining * usPerIter) / 1e6 : lastOk ? lastOk.etaSec : null;
  // 证明文件进度
  let proofCount = null;
  if (exponent) {
    const proofDir = path.join(DATA_DIR, String(exponent), 'proof');
    try {
      proofCount = fs.readdirSync(proofDir).length;
    } catch (e) {
      proofCount = null;
    }
  }

  // 历史：优先从 SQLite 查询（覆盖日志滚动 / 8MB 窗口之外的历史数据），
  // 查询不到时回退到当前日志解析的点（等距采样到 300 点）
  let progress = null;
  let speed = null;
  if (historyDb) {
    try {
      const workerIdx = worker.worker || 0;
      progress = historyDb.queryPoints({ worker: workerIdx, limit: 600 }, 'progress');
      speed = historyDb.queryPoints({ worker: workerIdx, limit: 600 }, 'speed');
    } catch (e) {
      console.error('[monitor] 查询历史数据库失败:', e.message);
    }
  }
  if (!progress || !progress.length) progress = sample(progressHistory, 300);
  if (!speed || !speed.length) speed = sample(speedHistory, 300);
  const history = { progress, speed };

  return {
    ...worker,
    logFile: name,
    logSize: data.size,
    lastLogAt,
    startCount,
    restartCountRecent,
    byeCount,
    lastLineIsBye,
    sessionStartAt,
    version,
    device,
    exponent,
    iteration,
    total,
    usPerIter,
    itersPerSec: itersPerSec ? +itersPerSec.toFixed(2) : null,
    percent: percent != null ? +percent.toFixed(4) : null,
    percentPerDay: percentPerDay != null ? +percentPerDay.toFixed(2) : null,
    etaSec: etaSec != null ? Math.round(etaSec) : null,
    lastOk: lastOk
      ? {
          iteration: lastOk.iteration,
          at: lastOk.ts ? fmtDateTime(lastOk.ts) : null,
          etaText: lastOk.etaText,
          z: lastOk.z,
          avg: lastOk.avg,
        }
      : null,
    fft,
    proofPower,
    proofCount,
    warnings: warnings.slice(-8),
    warningCount: warnings.length,
    history,
  };
}

function parsePrpll() {
  const logs = fs
    .readdirSync(DATA_DIR)
    .filter((f) => /^gpuowl-\d+\.log$/.test(f))
    .sort();
  if (!logs.length) {
    return {
      status: 'stopped',
      statusNote: '未找到 gpuowl-*.log',
      files: [],
      workers: [],
    };
  }
  const workers = cachedParse('prpll', logs, () => logs.map(parseGpuowlLog).filter(Boolean)).map(finalizeWorker);
  const statuses = workers.map((w) => w.status);
  let status = statuses.every((s) => s === 'running') ? 'running' : 'warning';
  if (statuses.some((s) => s === 'stopped')) status = 'stopped';
  const note = workers.map((w) => `worker ${w.worker}: ${w.statusNote}`).join('；');
  return {
    status,
    statusNote: note,
    files: logs.map(fileInfo),
    workers,
  };
}

// ---------------------------------------------------------------- AutoPrimeNet 解析

// 版本号与监控目录只在 AutoPrimeNet 启动时打印一次，尾部扫描窗口之外时
// 回退到全文件扫描（该信息运行期不变，扫描结果也缓存到内存避免反复读大文件）。
let apnPersistent = { version: null, watcher: null };

/** 扫描整个日志文件，提取只在启动时打印一次的版本号与监控目录 */
function scanApnPersistent() {
  const filePath = path.join(DATA_DIR, 'autoprimenet.log');
  try {
    const st = fs.statSync(filePath);
    if (!st.size) return apnPersistent;
    // 避免一次性读取超大文件：只读尾部 2MB（版本/目录行在每次启动时都会重新出现）
    const bytes = Math.min(st.size, APN_SCAN_BYTES);
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(bytes);
    const read = fs.readSync(fd, buf, 0, bytes, st.size - bytes);
    fs.closeSync(fd);
    const text = buf.toString('utf8', 0, read);
    const verM = /AutoPrimeNet assignment handler version ([0-9.]+)/.exec(text);
    if (verM) apnPersistent.version = verM[1];
    const watchM = /Watching the directory: '([^']+)'/.exec(text);
    if (watchM) apnPersistent.watcher = watchM[1];
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  return apnPersistent;
}

function parseApnInternal() {
  const name = 'autoprimenet.log';
  const data = safeReadLines(path.join(DATA_DIR, name));
  const out = {
    logFile: name,
    logSize: 0,
    lastLogAt: null,
    lastCheckTs: null,
    nextCheckTs: null,
    version: null,
    user: null,
    cpuBrand: null,
    checkIntervalH: 1,
    lastCheck: null,
    nextCheck: null,
    rollingAverage: null,
    msecPerIter: null,
    assignments: [],
    queueEtaSec: null,
    queueEta: null,
    queueDaysRequested: null,
    watcher: null,
    warnings: [],
    warningCount: 0,
  };

  if (!data) {
    scanApnPersistent();
    out.version = apnPersistent.version;
    out.watcher = apnPersistent.watcher;
    return out;
  }
  out.logSize = data.size;
  const lines = data.lines;
  const tail = lines.slice(-APN_PARSE_TAIL_LINES);
  const assignments = new Map();

  for (const line of tail) {
    const hdr = /^\[(\w+) (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+)\]\s+(\w+):\s*(.*)$/.exec(line);
    if (!hdr) continue;
    const [, , tsStr, level, msg] = hdr;
    const ts = parseIsoTs(tsStr.slice(0, 19));
    if (level === 'WARNING' || level === 'ERROR') {
      out.warnings.push({ ts, level, text: msg });
    }

    const verM = /AutoPrimeNet assignment handler version ([\.0-9]+)/.exec(msg);
    if (verM) {
      out.version = verM[1];
      apnPersistent.version = verM[1];
    }

    const gotM = /Got assignment (\w+): (\w+) M(\d+)/.exec(msg);
    if (gotM) {
      const [, aid, type, exp] = gotM;
      const key = exp;
      const cur = assignments.get(key) || { exponent: +exp, aid, worktype: type };
      cur.aid = aid;
      cur.worktype = type;
      assignments.set(key, cur);
    }

    const sendM = /Sending expected completion date for M(\d+):\s*(.+?)\s*\((\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\)/.exec(msg);
    if (sendM) {
      const [, exp, etaText, doneDate] = sendM;
      const key = exp;
      const cur = assignments.get(key) || { exponent: +exp };
      cur.etaText = etaText.replace(/\s+/g, ' ').trim();
      cur.etaSec = parseDuration(etaText);
      cur.doneDate = doneDate;
      cur.doneTs = parseIsoTs(doneDate);
      assignments.set(key, cur);
    }

    const nextM = /Next check at: (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/.exec(msg);
    if (nextM) {
      out.nextCheck = nextM[1];
      out.nextCheckTs = parseIsoTs(nextM[1]);
    }

    const rollM = /Updating 30-day rolling average to ([\d.]+)/.exec(msg);
    if (rollM) out.rollingAverage = parseFloat(rollM[1]);

    const queueM = /Estimated\s+(.+?)\s+to complete queued work,\s+([\d.]+)\s+days of work requested/.exec(msg);
    if (queueM) {
      out.queueEta = queueM[1].replace(/\s+/g, ' ').trim();
      out.queueDaysRequested = parseFloat(queueM[2]);
    }

    const watchM = /Watching the directory: '([^']+)'/.exec(msg);
    if (watchM) {
      out.watcher = watchM[1];
      apnPersistent.watcher = watchM[1];
    }

    if (/Will report results/.test(msg)) {
      out.lastCheck = tsStr.slice(0, 19);
      out.lastCheckTs = ts;
    }
  }

  // 过滤幽灵项：仅保留仍存在于工作文件（worktodo / certwork）的指数，
  // 取消分配或已完成但残留在日志中的任务不再展示
  const activeExps = new Set();
  for (const q of parseWorktodoFiles()) activeExps.add(q.exponent);
  for (const c of parseCertworkFiles()) activeExps.add(c.exponent);
  out.assignments = [...assignments.values()]
    .filter((a) => activeExps.has(a.exponent))
    .sort((a, b) => a.exponent - b.exponent);
  // 队列总耗时：单 worker 顺序执行，取分配中最后完成的那个（max ETA）
  const queueEtas = out.assignments.map((a) => a.etaSec).filter((v) => v != null);
  if (queueEtas.length) {
    const maxSec = Math.max(...queueEtas);
    out.queueEtaSec = Math.round(maxSec);
  }

  // 最近一行时间
  const lastLine = lines[lines.length - 1];
  const hdr = /^\[(\w+) (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/.exec(lastLine || '');
  out.lastLogAt = hdr ? parseIsoTs(hdr[2]) : data.mtimeMs;
  out.warningCount = out.warnings.length;
  out.warnings = out.warnings.slice(-6);
  // 版本号与监控目录已滚出尾部窗口时，回退到全文件扫描结果
  if (out.version == null || out.watcher == null) {
    scanApnPersistent();
    if (out.version == null) out.version = apnPersistent.version;
    if (out.watcher == null) out.watcher = apnPersistent.watcher;
  }
  return out;
}

/** 补全 AutoPrimeNet 随时间变化的字段（每次请求重新计算） */
function finalizeApn(out) {
  const nowMs = Date.now();
  const next = { ...out };
  next.lastLogAgoSec = next.lastLogAt
    ? Math.max(0, Math.round((nowMs - next.lastLogAt) / 1000))
    : null;
  next.nextCheckInSec =
    next.nextCheckTs != null ? Math.max(0, Math.round((next.nextCheckTs - nowMs) / 1000)) : null;
  next.queueEtaAt = next.queueEtaSec != null ? Math.round(nowMs + next.queueEtaSec * 1000) : null;

  if (!next.lastLogAt) {
    next.status = 'stopped';
    next.statusNote = '未找到 autoprimenet.log';
    return next;
  }
  const intervalSec = (next.checkIntervalH || 1) * 3600;
  if (next.lastLogAgoSec < intervalSec * 3) {
    next.status = 'running';
    next.statusNote = `最后日志 ${fmtDuration(next.lastLogAgoSec)} 前`;
  } else if (next.lastLogAgoSec < intervalSec * 8) {
    next.status = 'warning';
    next.statusNote = `最后日志 ${fmtDuration(next.lastLogAgoSec)} 前，可能已失联`;
  } else {
    next.status = 'stopped';
    next.statusNote = `最后日志 ${fmtDuration(next.lastLogAgoSec)} 前`;
  }
  return next;
}

/** 解析 "1d  6h 53m 46s" / "8h 41m 46s" 这类时长文本 -> 秒 */
function parseDuration(text) {
  const parts = text.trim().split(/\s+/);
  let sec = 0;
  for (const p of parts) {
    const m = /^(\d+)d$/.exec(p);
    if (m) { sec += +m[1] * 86400; continue; }
    const h = /^(\d+)h$/.exec(p);
    if (h) { sec += +h[1] * 3600; continue; }
    const mi = /^(\d+)m$/.exec(p);
    if (mi) { sec += +mi[1] * 60; continue; }
    const s = /^(\d+)s$/.exec(p);
    if (s) { sec += +s[1]; continue; }
  }
  return sec || null;
}

// ---------------------------------------------------------------- 配置文件 / 队列 / 结果

function parseIni() {
  return cachedParse('ini', ['prime.ini'], () => {
    const data = tailFile(path.join(DATA_DIR, 'prime.ini'), INI_MAX_BYTES);
    if (!data) return null;
    const kv = {};
    for (const line of data.text.split('\n')) {
      const m = /^\s*([A-Za-z_][\w]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (m) kv[m[1]] = m[2];
    }
    return {
      username: kv.username || kv.user_name || null,
      computerId: kv.ComputerID || null,
      cpuBrand: kv.CpuBrand || null,
      numCores: kv.NumCores ? +kv.NumCores : null,
      daysOfWork: kv.DaysOfWork ? parseFloat(kv.DaysOfWork) : null,
      hoursBetweenCheckins: kv.HoursBetweenCheckins ? parseFloat(kv.HoursBetweenCheckins) : 1,
      certWork: kv.CertWork === 'True' || kv.CertWork === 'true',
      workPreference: kv.WorkPreference || null,
      maxExponents: kv.MaxExponents ? +kv.MaxExponents : null,
      rollingAverage: kv.RollingAverage ? +kv.RollingAverage : null,
      msecPerIter: kv.msec_per_iter ? (Number.isFinite(+kv.msec_per_iter) ? +kv.msec_per_iter : null) : null,
      exponent: kv.exponent ? +kv.exponent : null,
      workFile: kv.work_file || null,
      resultsFile: kv.results_file || null,
    };
  });
}

/** 解析 certwork-*.txt（CERT 任务的 AID 与指数在这里，不在 worktodo 中） */
function parseCertworkFiles() {
  const files = fs.readdirSync(DATA_DIR).filter((f) => /^certwork(-\d+)?\.txt$/.test(f)).sort();
  return cachedParse('certwork', files, () => {
    const list = [];
    for (const file of files) {
      const data = safeReadLines(path.join(DATA_DIR, file), 1 * 1024 * 1024);
      if (!data) continue;
      data.lines.forEach((line, i) => {
        // Cert=<aid>,<k>,<b>,<n>,<c>,<bits>
        const m = /^Cert=([0-9A-F]{32}),\d+,\d+,(\d+),-?\d+,\d+/i.exec(line);
        if (!m) return;
        list.push({ file, order: i, exponent: +m[2], worktype: 'CERT', aid: m[1] });
      });
    }
    return list;
  });
}

/** 从 AutoPrimeNet 日志提取每个指数首次领取（Got assignment）的时间戳（epoch 毫秒） */
function parseAssignedAt() {
  const name = 'autoprimenet.log';
  return cachedParse('assigned-at', [name], () => {
    const data = tailFile(path.join(DATA_DIR, name), RESULTS_MAX_BYTES);
    if (!data) return {};
    const out = {};
    for (const line of data.text.split('\n')) {
      const m = /^\[\w+ (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\.\d+\]\s+\w+: Got assignment [0-9A-F]{32}: \w+ M(\d+)/.exec(line);
      if (!m) continue;
      const exp = parseInt(m[2], 10);
      if (out[exp] == null) out[exp] = parseIsoTs(m[1]); // AutoPrimeNet 日志为本地时间
    }
    return out;
  });
}

function parseWorktodoFiles() {
  const files = fs.readdirSync(DATA_DIR).filter((f) => /^worktodo(-\d+)?\.txt$/.test(f)).sort();
  return cachedParse('worktodo', files, () => {
    const queue = [];
    const typeLabel = {
      PRP: 'PRP',
      PRPDC: 'PRP 双检',
      CERT: '证书验证',
      PF: '因子分解',
      LL: 'LL',
      LLDC: 'LL 双检',
    };
    for (const file of files) {
      const data = safeReadLines(path.join(DATA_DIR, file), 1 * 1024 * 1024);
      if (!data) continue;
      data.lines.forEach((line, i) => {
        // 注意：PRPLL 写的 Cert 行是大小写混合的 "Cert="，正则需允许
        const m = /^([A-Za-z]+)=([0-9A-F]+),(\d+),(\d+),(\d+),(-?\d+),(\d+)/.exec(line);
        if (!m) return;
        const [, type, aid, , , exp, , bits] = m;
        const wt = type.toUpperCase();
        queue.push({
          file,
          order: i,
          exponent: +exp,
          worktype: wt,
          worktypeLabel: typeLabel[wt] || wt,
          aid,
          bits: +bits,
        });
      });
    }
    return queue;
  });
}

function parseResultsFiles() {
  const files = fs.readdirSync(DATA_DIR).filter((f) => /^results(-\d+)?\.txt$/.test(f)).sort();
  return cachedParse('results', files, () => {
    const results = [];
    for (const file of files) {
      const data = safeReadLines(path.join(DATA_DIR, file), 4 * 1024 * 1024);
      if (!data) continue;
      for (const line of data.lines) {
        try {
          const j = JSON.parse(line);
          results.push({
            file,
            exponent: j.exponent,
            status: j.status,
            worktype: j.worktype,
            res64: j.res64,
            sha3: j['sha3-hash'] || null,
            squarings: j.squarings != null ? +j.squarings : null,
            timestamp: j.timestamp,
            errors: j.errors ? j.errors.gerbicz : null,
            fftLength: j['fft-length'],
            proofPower: j.proof && j.proof.power,
            program: j.program ? `${j.program.name} ${j.program.version}` : null,
            aid: j.aid,
          });
        } catch (e) {
          // 忽略非 JSON 行
        }
      }
    }
    results.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));
    return results;
  });
}

/** 读取本地全部结果（含已上报的 results_sent-*），用于历史页合并 CERT 等记录 */
function parseAllLocalResults() {
  const files = fs.readdirSync(DATA_DIR).filter((f) => /^results(_sent)?(-\d+)?\.txt$/.test(f)).sort();
  return cachedParse('results-all', files, () => {
    const results = [];
    for (const file of files) {
      const data = safeReadLines(path.join(DATA_DIR, file), 8 * 1024 * 1024);
      if (!data) continue;
      for (const line of data.lines) {
        try {
          const j = JSON.parse(line);
          results.push({
            exponent: j.exponent,
            status: j.status,
            worktype: j.worktype,
            res64: j.res64,
            sha3: j['sha3-hash'] || null,
            timestamp: j.timestamp,
            program: j.program ? `${j.program.name} ${j.program.version}` : null,
          });
        } catch (e) {
          // 忽略非 JSON 行
        }
      }
    }
    results.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));
    return results;
  });
}

// ---------------------------------------------------------------- 状态汇总

/** 从 gpuowl 日志计算各指数的总耗时（秒）：首次出现到最后一次出现的间隔 */
function parseElapsedMap() {
  return cachedParse('elapsed', ['gpuowl-0.log'], () => {
    const data = safeReadLines(path.join(DATA_DIR, 'gpuowl-0.log'));
    if (!data) return {};
    const first = new Map();
    const last = new Map();
    for (const line of data.lines) {
      const tsM = /^(\d{8}) (\d{2}:\d{2}:\d{2})/.exec(line);
      if (!tsM) continue;
      const ts = parseGpuowlTs(tsM[0]);
      const expM = /^\d{8} \d{2}:\d{2}:\d{2}\s+(\d+)\s+/.exec(line);
      if (!expM) continue;
      const exp = parseInt(expM[1], 10);
      if (!first.has(exp)) first.set(exp, ts);
      last.set(exp, ts);
    }
    const out = {};
    for (const [exp, t0] of first) {
      const t1 = last.get(exp);
      if (t1 && t1 > t0) out[exp] = Math.round((t1 - t0) / 1000);
    }
    return out;
  });
}

// ---------------------------------------------------------------- 领取任务类型 / 存储统计

/** 领取任务类型选项（参考 AutoPrimeNet 官方 WorkPreference 列表，括号内为任务类型数字 ID，desc 为悬停 tooltip 简介） */
const WORK_PREFERENCE_OPTIONS = {
  4: {
    label: 'P-1 因数分解（4）',
    desc: '在 LL/PRP 测试前对指数进行 P-1 因数分解，找到因子即可跳过后续更耗时的素性测试。',
  },
  5: {
    label: 'ECM 因数分解（5）',
    desc: '使用椭圆曲线法（ECM）寻找中等大小的因子，通常用于已做完 P-1 仍无法拆分的指数。',
  },
  8: {
    label: 'ECM 梅森合数（8）',
    desc: '对已知合数的梅森数的余因子进行 ECM 因数分解，进一步拆分合数。',
  },
  12: {
    label: 'GPU 试除（12）',
    desc: '使用 GPU 进行试除法（Trial Factoring），快速排除带有小因子的指数。',
  },
  101: {
    label: '双检 LL 测试（101）',
    desc: '对已完成的 LL 测试进行二次验证（双检），确保首次结果正确。',
  },
  106: {
    label: '双检零位移 LL 测试（106）',
    desc: '使用零位移计数的双检 LL 测试，用于验证依赖位移计数的早期结果。',
  },
  150: {
    label: '首次 PRP 测试（150）',
    desc: '对尚未测试过的指数进行首次 PRP 素性测试，AutoPrimeNet 默认选项。',
  },
  151: {
    label: '双检 PRP 测试（151）',
    desc: '对已完成的 PRP 测试进行二次验证（双检），确保首次结果正确。',
  },
  152: {
    label: '世界纪录 PRP 测试（152）',
    desc: '针对靠近已知最大梅森素数的指数进行测试，有望冲击新的世界纪录。',
  },
  153: {
    label: '1 亿位 PRP 测试（153）',
    desc: '测试超过 1 亿位十进制数字的指数，属于 EFF 百万美元大奖级别。',
  },
  154: {
    label: '需 P-1 的最小首次 PRP（154）',
    desc: '优先领取需要先做 P-1 因数分解的最小可用首次 PRP 任务。',
  },
  155: {
    label: '带证明的 PRP 双检（155）',
    desc: '生成带可验证证明的 PRP 双检，通常可避免额外的 CERT 校验任务。',
  },
  156: {
    label: '带证明的非零位移 PRP 双检（156）',
    desc: '使用非零位移计数并生成可验证证明的 PRP 双检。',
  },
  160: {
    label: '首次 PRP（梅森合数）（160）',
    desc: '对梅森合数的余因子进行首次 PRP 素性测试，以证明其合数性质。',
  },
  161: {
    label: 'PRP 双检（梅森合数）（161）',
    desc: '对梅森合数的余因子进行 PRP 双检，验证首次测试结果。',
  },
};

function getWorkPreference() {
  const prime = parseIni();
  const v = prime && prime.workPreference != null ? prime.workPreference : null;
  const opt = v != null ? WORK_PREFERENCE_OPTIONS[v] : null;
  return {
    ok: true,
    value: v,
    label: opt ? opt.label : null,
    defaultValue: 150,
    options: WORK_PREFERENCE_OPTIONS,
  };
}

/** 更新 prime.ini 的 WorkPreference（AutoPrimeNet 每次轮询都会重读配置文件） */
function setWorkPreference(value) {
  const v = parseInt(value, 10);
  if (!(v in WORK_PREFERENCE_OPTIONS)) {
    return { ok: false, error: '不支持的任务类型: ' + value };
  }
  const p = path.join(DATA_DIR, 'prime.ini');
  let text;
  try {
    text = fs.readFileSync(p, 'utf8');
  } catch (e) {
    return { ok: false, error: '无法读取 prime.ini' };
  }
  const lines = text.split('\n');
  const out = [];
  let replaced = false;
  for (const line of lines) {
    if (/^\s*WorkPreference\s*=/.test(line)) {
      // 已有该键：替换第一个，丢弃重复行（兼容带行尾注释的写法，避免插入重复键）
      if (!replaced) {
        out.push(`WorkPreference = ${v}`);
        replaced = true;
      }
      continue;
    }
    out.push(line);
  }
  if (!replaced) {
    // 在 [PrimeNet] 段首行后插入一行
    const res = [];
    for (const line of out) {
      res.push(line);
      if (!replaced && /^\[PrimeNet\]\s*$/.test(line.trim())) {
        res.push(`WorkPreference = ${v}`);
        replaced = true;
      }
    }
    if (!replaced) res.push(`WorkPreference = ${v}`);
    text = res.join('\n');
  } else {
    text = out.join('\n');
  }
  try {
    fs.writeFileSync(p, text);
  } catch (e) {
    return { ok: false, error: '无法写入 prime.ini' };
  }
  // 使配置文件缓存失效，让前端立即读到新值
  if (fileCache.has('ini')) fileCache.delete('ini');
  return { ok: true, value: v, label: WORK_PREFERENCE_OPTIONS[v].label };
}

/** 扫描数据目录顶层条目（文件/目录），统计大小与文件数；60s 缓存避免频繁 du */
let storageCache = { at: 0, data: null };
function parseStorage() {
  const now = Date.now();
  if (storageCache.data && now - storageCache.at < 60 * 1000) return storageCache.data;
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(DATA_DIR, { withFileTypes: true });
  } catch (e) {
    return [];
  }
  for (const ent of entries) {
    const p = path.join(DATA_DIR, ent.name);
    try {
      const st = fs.statSync(p);
      if (ent.isDirectory()) {
        let size = 0;
        let count = 0;
        const stack = [p];
        while (stack.length) {
          const cur = stack.pop();
          let items;
          try {
            items = fs.readdirSync(cur, { withFileTypes: true });
          } catch (e) {
            continue;
          }
          for (const it of items) {
            const fp = path.join(cur, it.name);
            try {
              if (it.isDirectory()) stack.push(fp);
              else {
                size += fs.statSync(fp).size;
                count++;
              }
            } catch (e) {
              // 忽略无权限/损坏条目
            }
          }
        }
        out.push({ name: ent.name, type: 'dir', size, count, mtime: st.mtimeMs });
      } else {
        out.push({ name: ent.name, type: 'file', size: st.size, count: 1, mtime: st.mtimeMs });
      }
    } catch (e) {
      // 忽略
    }
  }
  out.sort((a, b) => b.size - a.size);
  storageCache = { at: now, data: out };
  return out;
}

/** 增量导入 gpuowl-*.log 的进度行到 SQLite（游标记录已处理偏移） */
function syncHistoryFromLogs() {
  if (!historyDb) return;
  try {
    const logs = fs
      .readdirSync(DATA_DIR)
      .filter((f) => /^gpuowl-(\d+)\.log$/.test(f))
      .sort();
    for (const f of logs) {
      const m = /^gpuowl-(\d+)\.log$/.exec(f);
      const worker = parseInt(m[1], 10);
      try {
        historyDb.importLog(f, worker);
      } catch (e) {
        console.error(`[monitor] 导入 ${f} 失败:`, e.message);
      }
    }
  } catch (e) {
    console.error('[monitor] 扫描日志失败:', e.message);
  }
}

function buildStatus() {
  // 增量导入：把 gpuowl-*.log 新增的进度行写入 SQLite（游标记录偏移，避免重复）
  syncHistoryFromLogs();
  const prpll = parsePrpll();
  const prime = parseIni();
  // 工作队列 = worktodo-*.txt + certwork-*.txt（CERT 任务可能尚未被 AutoPrimeNet 移入 worktodo）
  const queue = [
    ...parseWorktodoFiles(),
    ...parseCertworkFiles().map((c) => ({
      file: c.file,
      order: c.order,
      exponent: c.exponent,
      worktype: 'CERT',
      worktypeLabel: '证书验证',
      aid: c.aid,
      bits: null,
    })),
  ].sort((a, b) => a.file.localeCompare(b.file) || a.order - b.order);
  if (prime && prime.username) mersenne.setUsername(prime.username);
  const apnRaw = cachedParse('apn', ['autoprimenet.log'], parseApnInternal);
  // 浅拷贝 + assignments 深拷贝，避免改写 cachedParse 缓存的同一引用（M4）
  const apn = {
    ...apnRaw,
    assignments: (apnRaw.assignments || []).map((a) => ({ ...a })),
  };
  if (prime && prime.hoursBetweenCheckins) apn.checkIntervalH = prime.hoursBetweenCheckins;
  apn.user = apn.user || (prime && prime.username) || null;
  apn.cpuBrand = apn.cpuBrand || (prime && prime.cpuBrand) || null;
  if (apn.rollingAverage == null && prime) apn.rollingAverage = prime.rollingAverage;
  if (apn.msecPerIter == null && prime) apn.msecPerIter = prime.msecPerIter;

  // 用工作队列 + 证书队列补全分配信息的任务类型 / AID（CERT 任务在 certwork-*.txt）
  const byExp = new Map(queue.map((q) => [q.exponent, q]));
  const certByExp = new Map(parseCertworkFiles().map((c) => [c.exponent, c]));
  for (const a of apn.assignments) {
    const q = byExp.get(a.exponent) || certByExp.get(a.exponent);
    if (q) {
      a.worktype = a.worktype || q.worktype;
      a.aid = a.aid || q.aid;
    }
  }

  // 时间相关字段（年龄、状态、倒计时）放在配置合并之后计算
  const finalizedApn = finalizeApn(apn);

  let health = 'ok';
  if (prpll.status === 'stopped' || finalizedApn.status === 'stopped') health = 'error';
  else if (prpll.status === 'warning' || finalizedApn.status === 'warning') health = 'warning';

  return {
    generatedAt: Date.now(),
    serverTime: fmtDateTime(Date.now()),
    dataDir: DATA_DIR,
    health,
    prpll,
    apn: finalizedApn,
    prime,
    queue,
    results: parseResultsFiles().slice(0, RECENT_RESULTS),
    historyLocal: parseAllLocalResults(),
    assignedAt: parseAssignedAt(),
    files: ['gpuowl-0.log', 'autoprimenet.log', 'worktodo-0.txt', 'worktodo.txt', 'results-0.txt', 'prime.ini', 'config.txt']
      .map(fileInfo),
    elapsed: parseElapsedMap(),
    storage: parseStorage(),
  };
}

// ---------------------------------------------------------------- 日志 API

function classifyGpuowlLine(line) {
  if (GPUOWL_PROGRESS_RE.test(line) || GPUOWL_CERT_PROGRESS_RE.test(line)) {
    if (/ OK /.test(line)) return 'ok';
    return 'progress';
  }
  if (/PRPLL \S+ starting/.test(line)) return 'info';
  if (/^.*\{"/.test(line) || /"exponent":\d+/.test(line)) return 'result';
  if (/(ERROR|error|stuck|abort)/.test(line)) return 'error';
  if (/(WARNING|warn)/.test(line)) return 'warn';
  return 'info';
}

function classifyApnLine(line) {
  const m = /\]\s+(\w+):/.exec(line);
  const level = m ? m[1].toLowerCase() : 'info';
  if (level === 'warning') return 'warn';
  if (level === 'error') return 'error';
  if (/Sending expected completion|Got assignment/.test(line)) return 'ok';
  return 'info';
}

function getLogLines(name, linesCount = 200) {
  const filePath = path.join(DATA_DIR, name);
  const data = safeReadLines(filePath, MAX_TAIL_BYTES);
  if (!data) return null;
  const n = Math.min(MAX_LOG_LINES, Math.max(10, linesCount));
  const rawLines = data.lines.slice(-n);
  const classify = name.startsWith('gpuowl') ? classifyGpuowlLine : classifyApnLine;
  return {
    name,
    size: data.size,
    mtime: data.mtimeMs,
    tailLines: data.lines.length,
    lines: rawLines.map((text, i) => ({
      index: data.lines.length - rawLines.length + i,
      level: classify(text),
      text,
    })),
  };
}

// ---------------------------------------------------------------- HTTP 服务

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json',
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendText(res, status, text, type) {
  res.writeHead(status, {
    'Content-Type': type || 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    const MAX_BODY = 1024 * 1024;
    const timeout = setTimeout(() => {
      reject(new Error('读取请求体超时'));
      req.destroy();
    }, 10000);
    const done = (fn, arg) => {
      clearTimeout(timeout);
      fn(arg);
    };
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY) {
        done(reject, new Error('请求体过大'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!body.trim()) return done(resolve, {});
      try {
        done(resolve, JSON.parse(body));
      } catch (e) {
        done(reject, new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', (e) => done(reject, e));
  });
}

function serveStatic(res, urlPath) {
  let rel;
  try {
    rel = decodeURIComponent(urlPath).replace(/^\/+/, '');
  } catch (e) {
    sendText(res, 400, '请求错误');
    return;
  }
  if (rel === '/' || rel === '' || rel === '/index.html') rel = 'index.html';
  // 路径穿越防护：拒绝任何含 .. 或绝对路径的候选（new URL 不解析 %2e/%2f 编码）
  if (/\.\./.test(rel) || rel.startsWith('/') || /^[a-zA-Z]:/.test(rel)) {
    sendText(res, 404, '未找到');
    return;
  }
  const candidates = [];
  if (rel.startsWith('vendor/')) {
    candidates.push(path.join(VENDOR_DIR, rel.slice('vendor/'.length)));
  } else {
    candidates.push(path.join(PUBLIC_DIR, rel));
    candidates.push(path.join(VENDOR_DIR, rel));
  }
  for (const filePath of candidates) {
    // 归一化后再校验，确保解析后的路径仍在 ROOT 内（防编码穿越）
    const resolved = path.resolve(filePath);
    if (resolved !== ROOT && !resolved.startsWith(ROOT + path.sep)) continue;
    try {
      const st = fs.statSync(resolved);
      if (!st.isFile()) continue;
      const ext = path.extname(resolved).toLowerCase();
      const body = fs.readFileSync(resolved);
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
        'Content-Length': body.length,
      });
      res.end(body);
      return;
    } catch (e) {
      // 尝试下一个候选路径
    }
  }
  sendText(res, 404, '未找到');
}

function handleLogStream(req, res, name, linesCount) {
  const filePath = path.join(DATA_DIR, name);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');

  let timer = null;
  let lastSize = -1;
  let lastMtime = -1;
  let lastIno = -1;

  // 客户端已断开或 socket 已销毁时不写入，避免对已销毁 socket 抛 ERR_STREAM_DESTROYED 崩掉进程
  const isClosed = () => res.writableEnded || res.destroyed || req.aborted;
  const safeEmit = (event, data) => {
    if (isClosed()) return;
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch (e) {
      /* 忽略写入失败 */
    }
  };

  const emit = safeEmit;
  let heartbeat = null;
  // 底层 socket 报错（如客户端重置）时停止所有定时器
  res.on('error', () => {
    clearInterval(timer);
    if (heartbeat) clearInterval(heartbeat);
  });

  const snapshot = (initial) => {
    // 先 stat 比较 size/mtime/inode，未变化就不重新读文件（避免每 tick 全量读日志）
    let st;
    try {
      st = fs.statSync(filePath);
    } catch (e) {
      emit('error', { message: '日志文件不存在' });
      return;
    }
    if (st.size === lastSize && st.mtimeMs === lastMtime && st.ino === lastIno && !initial) return;
    // 日志轮转判定：inode 变化（新文件）或 size 变小或 mtime 回退
    if ((lastIno !== -1 && st.ino !== lastIno) || st.size < lastSize || st.mtimeMs < lastMtime) {
      // 日志轮转 / 被截断：重新发送快照
      lastSize = st.size;
      lastMtime = st.mtimeMs;
      lastIno = st.ino;
      emit('rotated', { message: '日志已轮转，重新加载' });
      const snapshotData = getLogLines(name, linesCount);
      emit('snapshot', snapshotData);
      return;
    }
    const data = safeReadLines(filePath, MAX_TAIL_BYTES);
    if (!data) {
      emit('error', { message: '日志文件不存在' });
      return;
    }
    const n = Math.min(MAX_LOG_LINES, Math.max(10, linesCount));
    const rawLines = data.lines.slice(-n);
    if (initial) {
      lastSize = data.size;
      lastMtime = data.mtimeMs;
      lastIno = st.ino;
      emit('snapshot', {
        name,
        size: data.size,
        mtime: data.mtimeMs,
        tailLines: data.lines.length,
        lines: rawLines.map((text, i) => ({
          index: data.lines.length - rawLines.length + i,
          level: name.startsWith('gpuowl') ? classifyGpuowlLine(text) : classifyApnLine(text),
          text,
        })),
      });
      return;
    }
    if (data.size > lastSize) {
      const fd = fs.openSync(filePath, 'r');
      const len = data.size - lastSize;
      const buf = Buffer.alloc(len);
      let off = 0;
      while (off < len) {
        const n = fs.readSync(fd, buf, off, len - off, lastSize + off);
        if (n <= 0) break;
        off += n;
      }
      fs.closeSync(fd);
      const newText = buf.toString('utf8', 0, off);
      lastSize = data.size;
      lastMtime = data.mtimeMs;
      lastIno = st.ino;
      const added = newText.split('\n').filter((l) => l.length > 0);
      if (added.length) {
        emit('lines', {
          lines: added.map((text) => ({
            text,
            level: name.startsWith('gpuowl') ? classifyGpuowlLine(text) : classifyApnLine(text),
          })),
        });
      }
    } else {
      lastMtime = data.mtimeMs;
      lastIno = st.ino;
    }
  };

  // 首次初始化 lastIno（供轮转判定）
  snapshot(true);
  timer = setInterval(() => {
    try {
      snapshot(false);
    } catch (e) {
      emit('error', { message: String(e.message || e) });
    }
  }, 1500);

  heartbeat = setInterval(() => {
    if (isClosed()) {
      clearInterval(heartbeat);
      return;
    }
    try {
      res.write(': ping\n\n');
    } catch (e) {
      clearInterval(heartbeat);
    }
  }, 20000);
  req.on('close', () => {
    clearInterval(timer);
    clearInterval(heartbeat);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  try {
    // 控制接口鉴权：设置 MONITOR_TOKEN 后，所有 POST /api/* 必须携带 x-auth-token
    if (
      AUTH_TOKEN &&
      req.method === 'POST' &&
      pathname.startsWith('/api/') &&
      req.headers['x-auth-token'] !== AUTH_TOKEN
    ) {
      sendJson(res, 401, { ok: false, error: '未授权：缺少或错误的访问令牌（x-auth-token）' });
      return;
    }

    if (pathname === '/api/status') {
      sendJson(res, 200, buildStatus());
      return;
    }

    if (pathname === '/api/mersenne') {
      const force = req.method === 'POST' && url.searchParams.get('refresh') === '1';
      const prime = parseIni();
      if (prime && prime.username) mersenne.setUsername(prime.username);
      const data = await mersenne.getMersenne(force);
      sendJson(res, data.ok ? 200 : 502, data);
      return;
    }

    if (pathname === '/api/mersenne/refresh' && req.method === 'POST') {
      const prime = parseIni();
      if (prime && prime.username) mersenne.setUsername(prime.username);
      const data = await mersenne.getMersenne(true);
      sendJson(res, data.ok ? 200 : 502, data);
      return;
    }

    if (pathname === '/api/tasks' && req.method === 'GET') {
      sendJson(res, 200, tasks.getTasksSummary());
      return;
    }

    if (pathname === '/api/tasks/pause' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const result = await tasks.pauseTask(parseInt(body.exponent, 10), body.immediate === true);
      sendJson(res, result.ok ? 200 : 404, result);
      return;
    }

    if (pathname === '/api/tasks/resume' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const result = await tasks.resumeTask(parseInt(body.exponent, 10));
      sendJson(res, result.ok ? 200 : 404, result);
      return;
    }

    if (pathname === '/api/tasks/cancel' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const result = await tasks.cancelTask(
        parseInt(body.exponent, 10),
        body.unreserve === true,
        body.immediate === true
      );
      sendJson(res, result.ok ? 200 : 404, result);
      return;
    }

    if (pathname === '/api/tasks/add' && req.method === 'POST') {
      const body = await readJsonBody(req);
      if (!body.lines || !body.lines.length) {
        sendJson(res, 400, { ok: false, error: '缺少任务行（lines）' });
        return;
      }
      const result = await tasks.addTasks(body.lines);
      sendJson(res, 200, result);
      return;
    }

    if (pathname === '/api/tasks/import/candidates' && req.method === 'POST') {
      const result = await tasks.getImportCandidates();
      sendJson(res, result.ok ? 200 : 502, result);
      return;
    }

    if (pathname === '/api/tasks/import' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const result = await tasks.importFromPrimeNet(body.exponents);
      sendJson(res, result.ok ? 200 : 502, result);
      return;
    }

    // 领取任务类型（WorkPreference）
    if (pathname === '/api/settings/workpreference' && req.method === 'GET') {
      sendJson(res, 200, getWorkPreference());
      return;
    }
    if (pathname === '/api/settings/workpreference' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const result = setWorkPreference(body.value);
      sendJson(res, result.ok ? 200 : 400, result);
      return;
    }

    const logM = /^\/api\/log\/([^/]+)$/.exec(pathname);
    if (logM) {
      const name = logM[1];
      if (!LOG_NAME_RE.test(name)) {
        sendJson(res, 400, { error: '非法日志文件名' });
        return;
      }
      const lines = parseInt(url.searchParams.get('lines') || '200', 10);
      const data = getLogLines(name, lines);
      if (!data) sendJson(res, 404, { error: '日志文件不存在' });
      else sendJson(res, 200, data);
      return;
    }

    const streamM = /^\/api\/log-stream\/([^/]+)$/.exec(pathname);
    if (streamM) {
      const name = streamM[1];
      if (!LOG_NAME_RE.test(name)) {
        sendJson(res, 400, { error: '非法日志文件名' });
        return;
      }
      const lines = parseInt(url.searchParams.get('lines') || '200', 10);
      handleLogStream(req, res, name, lines);
      return;
    }

    if (pathname.startsWith('/api/')) {
      sendJson(res, 404, { error: '未知 API' });
      return;
    }

    serveStatic(res, pathname);
  } catch (e) {
    sendJson(res, 500, { error: String(e.message || e) });
  }
});

server.on('error', (e) => {
  console.error('[monitor] 服务器错误:', e.message);
  if (e.code === 'EADDRINUSE') console.error(`[monitor] 端口 ${PORT} 已被占用`);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`[monitor] GIMPS 监控中心已启动`);
  console.log(`[monitor] 数据目录: ${DATA_DIR}`);
  console.log(`[monitor] 访问地址: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  // 数据库未初始化（首次启动 / 表为空）时，触发一次性的日志全量回溯导入
  if (historyDb && !historyDb.isInitialized()) {
    console.log('[monitor] 历史数据库为空，开始全量回溯导入日志数据…');
    try {
      const r = historyDb.fullImportAll();
      console.log(`[monitor] 全量导入完成：${r.files} 个日志文件，共 ${r.points} 个进度点`);
    } catch (e) {
      console.error('[monitor] 全量导入失败:', e.message);
    }
  } else if (historyDb) {
    const st = historyDb.stats();
    if (st && st.count > 0) {
      console.log(`[monitor] 历史数据库已有数据：${st.count} 个进度点`);
    }
  }
});

process.on('SIGINT', () => {
  console.log('[monitor] 正在退出…');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000);
});
