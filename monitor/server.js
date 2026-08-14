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

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const VENDOR_DIR = path.join(ROOT, 'vendor');
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, '..', 'data'));
const PORT = parseInt(process.env.PORT || '8080', 10);
const HOST = process.env.HOST || '0.0.0.0';

const LOG_NAME_RE = /^(gpuowl-\d+\.log|autoprimenet\.log)$/;
const MAX_TAIL_BYTES = 8 * 1024 * 1024; // 最多读取 8MB 尾部用于解析
const MAX_LOG_LINES = 1000;             // /api/log 默认最多返回行数

// ---------------------------------------------------------------- 小工具

const pad = (n, w = 2) => String(n).padStart(w, '0');

function fmtTime(ts) {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

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

/** 解析 gpuowl 时间戳 "20260813 15:43:49" -> epoch 毫秒（本地时区） */
function parseGpuowlTs(str) {
  const m = /^(\d{4})(\d{2})(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(str);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number);
  return new Date(y, mo - 1, d, h, mi, s).getTime();
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
  if (points.length <= n) return points;
  const step = (points.length - 1) / (n - 1);
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(points[Math.round(i * step)]);
  }
  out[n - 1] = points[points.length - 1];
  return out;
}

// ---------------------------------------------------------------- PRPLL 解析

const GPUOWL_PROGRESS_RE =
  /^(\d{8}) (\d{2}:\d{2}:\d{2}) +(\d+) +(?:OK +)?(\d+) +([0-9a-f]{16}) +(\d+)(?: +ETA [^;]+)?/;

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
    if (lastLogAgoSec < 10 * 60) {
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

  const session = sessionStartIdx >= 0 ? lines.slice(sessionStartIdx) : lines;

  let version = null;
  let device = null;
  let fft = null;
  let proofPower = null;
  let lastProgress = null;   // 最近一条进度/OK 行
  let lastOk = null;         // 最近 OK 行
  let currentExponent = null;
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

      // 历史点（按当前指数）
      if (currentExponent) {
        progressHistory.push([ts, (iteration / exp) * 100]);
        if (us > 0) speedHistory.push([ts, 1e6 / us]);
      }
      continue;
    }

    // 告警 / 错误行
    if (/(WARNING|ERROR|error|stuck|abort|restarting)/i.test(line) && !/errors":\d+/.test(line)) {
      warnings.push(line);
    }
  }

  const lastLine = lines[lastIdx];
  const lastLogAt = parseGpuowlTs(lastLine ? lastLine.slice(0, 17) : '') || data.mtimeMs;

  // 当前任务信息
  let exponent = lastProgress ? lastProgress.exponent : null;
  let iteration = lastProgress ? lastProgress.iteration : null;
  let usPerIter = lastProgress ? lastProgress.usPerIter : null;
  const percent = exponent && iteration != null ? (iteration / exponent) * 100 : null;
  const itersPerSec = usPerIter ? 1e6 / usPerIter : null;
  const percentPerDay =
    usPerIter && exponent ? ((86400e6 / usPerIter) / exponent) * 100 : null;
  const remaining = exponent && iteration != null ? exponent - iteration : null;
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

  // 历史（当前指数）：等距采样到 300 点
  const history = {
    progress: sample(progressHistory, 300),
    speed: sample(speedHistory, 300),
  };

  return {
    ...worker,
    logFile: name,
    logSize: data.size,
    lastLogAt,
    startCount,
    sessionStartAt,
    version,
    device,
    exponent,
    iteration,
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

  if (!data) return out;
  out.logSize = data.size;
  const lines = data.lines;
  const tail = lines.slice(-400);
  const assignments = new Map();

  for (const line of tail) {
    const hdr = /^\[(\w+) (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+)\]\s+(\w+):\s*(.*)$/.exec(line);
    if (!hdr) continue;
    const [, , tsStr, level, msg] = hdr;
    const ts = parseIsoTs(tsStr.slice(0, 19));
    if (level === 'WARNING' || level === 'ERROR') {
      out.warnings.push({ ts, level, text: msg });
    }

    const verM = /AutoPrimeNet assignment handler version ([\d.]+)/.exec(msg);
    if (verM) out.version = verM[1];

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

    const watchM = /Watching the directory: '(.+)'/.exec(msg);
    if (watchM) out.watcher = watchM[1];

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
    const data = tailFile(path.join(DATA_DIR, 'prime.ini'), 64 * 1024);
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
      msecPerIter: kv.msec_per_iter ? parseFloat(kv.msec_per_iter) : null,
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

function parseWorktodoFiles() {
  const files = fs.readdirSync(DATA_DIR).filter((f) => /^worktodo(-\d+)?\.txt$/.test(f)).sort();
  return cachedParse('worktodo', files, () => {
    const queue = [];
    const typeLabel = {
      PRP: 'PRP',
      PRPDC: 'PRP 双重检查',
      CERT: '证书验证',
      PF: '因子分解',
      LL: 'LL',
      LLDC: 'LL 双重检查',
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

/** 领取任务类型选项（PRPLL 支持的 WorkPreference） */
const WORK_PREFERENCE_OPTIONS = {
  150: '首次 PRP 测试',
  151: 'PRP 双重检查',
  155: 'PRP 双重检查（带证明）',
  160: '首次 PRP（合数）',
  161: 'PRP 双重检查（合数）',
};

function getWorkPreference() {
  const prime = parseIni();
  const v = prime && prime.workPreference != null ? prime.workPreference : null;
  return {
    ok: true,
    value: v,
    label: v != null ? WORK_PREFERENCE_OPTIONS[v] || null : null,
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
  let replaced = false;
  const out = lines.map((line) => {
    const m = /^(\s*WorkPreference\s*=\s*)\d+\s*$/.exec(line);
    if (m) {
      replaced = true;
      return `${m[1]}${v}`;
    }
    return line;
  });
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
  return { ok: true, value: v, label: WORK_PREFERENCE_OPTIONS[v] };
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

function buildStatus() {
  const prpll = parsePrpll();
  const prime = parseIni();
  const queue = parseWorktodoFiles();
  if (prime && prime.username) mersenne.setUsername(prime.username);
  const apnRaw = cachedParse('apn', ['autoprimenet.log'], parseApnInternal);
  const apn = apnRaw; // 先合并配置，再计算时间相关字段
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
    results: parseResultsFiles().slice(0, 20),
    historyLocal: parseAllLocalResults(),
    files: ['gpuowl-0.log', 'autoprimenet.log', 'worktodo-0.txt', 'worktodo.txt', 'results-0.txt', 'prime.ini', 'config.txt']
      .map(fileInfo),
    elapsed: parseElapsedMap(),
    storage: parseStorage(),
  };
}

// ---------------------------------------------------------------- 日志 API

function classifyGpuowlLine(line) {
  if (GPUOWL_PROGRESS_RE.test(line)) {
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
    totalLines: data.lines.length,
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
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error('请求体过大'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!body.trim()) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (e) {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(res, urlPath) {
  let rel = decodeURIComponent(urlPath).replace(/^\/+/, '');
  if (rel === '/' || rel === '') rel = '/index.html';
  const candidates = [];
  if (rel.startsWith('vendor/')) {
    candidates.push(path.join(VENDOR_DIR, rel.slice('vendor/'.length)));
  } else {
    candidates.push(path.join(PUBLIC_DIR, rel));
    candidates.push(path.join(VENDOR_DIR, rel));
  }
  for (const filePath of candidates) {
    if (!filePath.startsWith(ROOT + path.sep)) continue;
    try {
      const st = fs.statSync(filePath);
      if (!st.isFile()) continue;
      const ext = path.extname(filePath).toLowerCase();
      const body = fs.readFileSync(filePath);
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
  sendText(res, 404, 'Not Found');
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

  const emit = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const snapshot = (initial) => {
    const data = safeReadLines(filePath, MAX_TAIL_BYTES);
    if (!data) {
      emit('error', { message: '日志文件不存在' });
      return;
    }
    if (data.size < lastSize || data.mtimeMs < lastMtime) {
      // 日志轮转 / 被截断：重新发送快照
      lastSize = data.size;
      lastMtime = data.mtimeMs;
      emit('rotated', { message: '日志已轮转，重新加载' });
      const snapshotData = getLogLines(name, linesCount);
      emit('snapshot', snapshotData);
      return;
    }
    const n = Math.min(MAX_LOG_LINES, Math.max(10, linesCount));
    const rawLines = data.lines.slice(-n);
    if (initial) {
      lastSize = data.size;
      lastMtime = data.mtimeMs;
      emit('snapshot', {
        name,
        size: data.size,
        mtime: data.mtimeMs,
        totalLines: data.lines.length,
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
    }
  };

  snapshot(true);
  timer = setInterval(() => {
    try {
      snapshot(false);
    } catch (e) {
      emit('error', { message: String(e.message || e) });
    }
  }, 1500);

  const heartbeat = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => {
    clearInterval(timer);
    clearInterval(heartbeat);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  try {
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

server.listen(PORT, HOST, () => {
  console.log(`[monitor] GIMPS 监控中心已启动`);
  console.log(`[monitor] 数据目录: ${DATA_DIR}`);
  console.log(`[monitor] 访问地址: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
});

process.on('SIGINT', () => {
  console.log('[monitor] 正在退出…');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000);
});
