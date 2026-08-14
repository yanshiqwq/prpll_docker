/**
 * 任务队列管理模块
 *
 * 直接操作 data/ 下的 worktodo-*.txt / certwork-*.txt，
 * 与 AutoPrimeNet 共用同名的 `.lck` 锁文件，避免并发写冲突。
 *
 * 功能：
 *   - 暂停：把任务行从队列移到 .monitor-queue.json 的 paused 列表
 *   - 恢复：加回队列末尾
 *   - 取消：从队列移除（可选同步取消 PrimeNet 分配，t=au）
 *   - 添加：追加手动输入的任务行
 *   - 导入：把 PrimeNet 上已分配但本地缺失的任务补齐到队列
 */
'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const mersenne = require('./mersenne');

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const STATE_FILE = '.monitor-queue.json';
const LOCK_WAIT_MS = 20000;
const DOCKER_SOCKET = process.env.DOCKER_SOCKET || '/var/run/docker.sock';
const PRPLL_CONTAINER = process.env.PRPLL_CONTAINER || '';

function dataPath(...parts) {
  return path.join(DATA_DIR, ...parts);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------- Docker API（发送 SIGINT 给 PRPLL）

function dockerApi(method, apiPath, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath: DOCKER_SOCKET,
        path: apiPath,
        method,
        timeout: timeoutMs,
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      }
    );
    req.on('timeout', () => {
      req.destroy(new Error('Docker API 超时'));
    });
    req.on('error', reject);
    req.end();
  });
}

/** 找到 prpll 容器名：优先环境变量，否则按 compose label 查询 */
async function findPrpllContainer() {
  if (PRPLL_CONTAINER) return PRPLL_CONTAINER;
  const filters = encodeURIComponent(JSON.stringify({ label: ['com.docker.compose.service=prpll'] }));
  // all=1：包含已停止的容器，以便给出更准确的提示
  const r = await dockerApi('GET', `/containers/json?all=1&filters=${filters}`);
  if (r.status !== 200) throw new Error(`Docker API ${r.status}`);
  const list = JSON.parse(r.body || '[]');
  if (!list.length) return null;
  const name = list[0].Names[0].replace(/^\//, '');
  if (!list[0].State || list[0].State !== 'running') {
    throw new Error(`找到 prpll 容器 ${name}，但它当前未在运行（无法发送停止信号）`);
  }
  return name;
}

async function signalPrpll(signal = 'SIGINT') {
  const name = await findPrpllContainer();
  if (!name) {
    throw new Error('未找到运行中的 prpll 容器（请检查 docker-compose 服务名或设置 PRPLL_CONTAINER）');
  }
  const r = await dockerApi('POST', `/containers/${encodeURIComponent(name)}/kill?signal=${signal}`);
  if (r.status !== 204 && r.status !== 200) {
    throw new Error(`向容器 ${name} 发送 ${signal} 失败（HTTP ${r.status}）：${r.body.slice(0, 200)}`);
  }
  return name;
}

function readLogTail(filePath, maxBytes = 8192) {
  try {
    const st = fs.statSync(filePath);
    if (st.size <= maxBytes) return fs.readFileSync(filePath, 'utf8');
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(maxBytes);
    const read = fs.readSync(fd, buf, 0, maxBytes, st.size - maxBytes);
    fs.closeSync(fd);
    return buf.toString('utf8', 0, read).slice(buf.toString('utf8', 0, read).indexOf('\n') + 1);
  } catch (e) {
    return '';
  }
}

/** 等待 PRPLL 保存检查点退出（日志出现 "Stopping, please wait.." 或 "Bye"） */
async function waitForPrpllStop(timeoutMs = 90000) {
  const start = Date.now();
  let sawStopping = false;
  while (Date.now() - start < timeoutMs) {
    const tail = readLogTail(dataPath('gpuowl-0.log'));
    if (/Stopping, please wait/.test(tail)) sawStopping = true;
    if (sawStopping && /Bye\b/.test(tail)) {
      return { ok: true, note: 'PRPLL 已保存检查点并退出，Docker 将自动重启' };
    }
    await sleep(2000);
  }
  if (sawStopping) {
    return { ok: true, note: 'PRPLL 已收到停止信号（检查点保存中），即将重启' };
  }
  throw new Error('未检测到 PRPLL 停止信号（请确认 docker.sock 已挂载且 PRPLL 容器在运行）');
}

// ---------------------------------------------------------------- 文件锁（与 AutoPrimeNet 兼容）

async function withLock(filePath, fn) {
  const lockFile = filePath + '.lck';
  const start = Date.now();
  for (;;) {
    try {
      const fd = fs.openSync(lockFile, 'wx');
      fs.closeSync(fd);
      try {
        return await fn();
      } finally {
        try {
          fs.unlinkSync(lockFile);
        } catch (e) {
          /* 忽略 */
        }
      }
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (Date.now() - start > LOCK_WAIT_MS) {
        throw new Error(`无法获取文件锁 ${lockFile}（AutoPrimeNet 可能正在操作队列，请稍后重试）`);
      }
      await sleep(250);
    }
  }
}

// ---------------------------------------------------------------- 状态文件

function readState() {
  try {
    const s = JSON.parse(fs.readFileSync(dataPath(STATE_FILE), 'utf8'));
    if (!Array.isArray(s.paused)) s.paused = [];
    return s;
  } catch (e) {
    return { paused: [] };
  }
}

function writeState(state) {
  fs.writeFileSync(dataPath(STATE_FILE), JSON.stringify(state, null, 2));
}

// ---------------------------------------------------------------- 任务行解析

const LINE_RE = /^([A-Za-z]+)=([^,]+),([^,]+),([^,]+),(\d+),(-?\d+)(?:,([^,]*))?(?:,([^,]*))?(?:,([^,]*))?(?:,([^,]*))?(?:,([^,]*))?/;

function parseLine(text) {
  const line = String(text).trim();
  const m = LINE_RE.exec(line);
  if (!m) return null;
  return {
    line,
    type: m[1].toUpperCase(),
    aid: m[2],
    k: parseFloat(m[3]),
    b: parseFloat(m[4]),
    exponent: parseInt(m[5], 10),
    c: parseInt(m[6], 10),
    bits: m[7] != null && m[7] !== '' ? parseFloat(m[7]) : null,
  };
}

function listWorkfiles() {
  let files;
  try {
    files = fs.readdirSync(DATA_DIR);
  } catch (e) {
    return [];
  }
  return files
    .filter((f) => /^(worktodo|certwork)(-\d+)?\.txt$/.test(f))
    .sort();
}

function getComputerGuid() {
  return getIniValue('ComputerGUID');
}

function getIniValue(key) {
  try {
    const text = fs.readFileSync(dataPath('prime.ini'), 'utf8');
    const m = new RegExp(`^\\s*${key}\\s*=\\s*(.+)$`, 'm').exec(text);
    return m ? m[1].trim() : null;
  } catch (e) {
    return null;
  }
}

function readLines(filePath) {
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    return text.split('\n').filter((l) => l.trim().length > 0);
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

function writeLines(filePath, lines) {
  fs.writeFileSync(filePath, lines.join('\n') + (lines.length ? '\n' : ''));
}

/** 所有队列文件中的任务（含解析信息） */
function listAllTasks() {
  const files = listWorkfiles();
  const tasks = [];
  for (const file of files) {
    const lines = readLines(dataPath(file));
    lines.forEach((line, i) => {
      const parsed = parseLine(line);
      if (parsed) tasks.push({ file, lineNo: i + 1, ...parsed });
    });
  }
  return tasks;
}

// ---------------------------------------------------------------- 暂停 / 恢复 / 取消

function findTask(exponent) {
  const tasks = listAllTasks();
  return tasks.find((t) => t.exponent === exponent) || null;
}

function removeLineFromFile(file, exponent) {
  const filePath = dataPath(file);
  const lines = readLines(filePath);
  const hit = lines.find((l) => {
    const p = parseLine(l);
    return p && p.exponent === exponent;
  });
  if (!hit) return null;
  const next = lines.filter((l) => {
    const p = parseLine(l);
    return !(p && p.exponent === exponent);
  });
  writeLines(filePath, next);
  return hit;
}

function appendLineToFile(file, line) {
  const filePath = dataPath(file);
  const lines = readLines(filePath);
  lines.push(line);
  writeLines(filePath, lines);
}

async function pauseTask(exponent, immediate = false) {
  const task = findTask(exponent);
  if (!task) return { ok: false, error: `队列中未找到指数 ${exponent}` };

  const state = readState();
  if (state.paused.some((p) => p.exponent === exponent)) {
    return { ok: false, error: `指数 ${exponent} 已在暂停列表中` };
  }

  await withLock(dataPath(task.file), () => {
    const removed = removeLineFromFile(task.file, exponent);
    if (removed) {
      state.paused.push({
        line: removed,
        file: task.file,
        exponent,
        type: parseLine(removed)?.type || '?',
        pausedAt: new Date().toISOString(),
      });
      writeState(state);
    }
  });
  let prpll = null;
  if (immediate) {
    try {
      const container = await signalPrpll('SIGINT');
      const stop = await waitForPrpllStop();
      prpll = { ok: true, container, note: stop.note };
    } catch (e) {
      prpll = { ok: false, error: String(e.message || e) };
    }
  }
  return { ok: true, exponent, action: 'paused', prpll };
}

async function resumeTask(exponent) {
  const state = readState();
  const idx = state.paused.findIndex((p) => p.exponent === exponent);
  if (idx < 0) return { ok: false, error: `指数 ${exponent} 不在暂停列表中` };
  const item = state.paused[idx];

  await withLock(dataPath(item.file), () => {
    appendLineToFile(item.file, item.line);
  });
  state.paused.splice(idx, 1);
  writeState(state);
  return { ok: true, exponent, action: 'resumed' };
}

async function cancelTask(exponent, unreserve = false, immediate = false) {
  const state = readState();
  const pausedIdx = state.paused.findIndex((p) => p.exponent === exponent);
  let line = null;
  let file = null;

  const task = findTask(exponent);
  if (task) {
    file = task.file;
    line = task.line;
    await withLock(dataPath(file), () => {
      removeLineFromFile(file, exponent);
    });
  }
  if (pausedIdx >= 0) {
    line = line || state.paused[pausedIdx].line;
    file = file || state.paused[pausedIdx].file;
    state.paused.splice(pausedIdx, 1);
    writeState(state);
  }
  if (!line) return { ok: false, error: `队列与暂停列表中都未找到指数 ${exponent}` };

  const parsed = parseLine(line);
  // 立即生效：先发 SIGINT（PRPLL 保存检查点退出，Docker 自动重启），
  // 再处理 PrimeNet 网络请求，最后等待停止确认
  let prpll = null;
  if (immediate) {
    try {
      const container = await signalPrpll('SIGINT');
      prpll = { ok: true, container };
    } catch (e) {
      prpll = { ok: false, error: String(e.message || e) };
    }
  }
  let primeNet = null;
  if (unreserve) {
    primeNet = await mersenne.unreserveByAid(parsed.aid, getComputerGuid());
    // 取消成功后清掉 PrimeNet 抓取缓存，避免面板继续显示旧分配
    if (primeNet && primeNet.ok) mersenne.clearCache();
  }
  if (prpll) {
    if (prpll.ok) {
      try {
        const stop = await waitForPrpllStop();
        prpll.note = stop.note;
      } catch (e) {
        prpll.note = String(e.message || e);
      }
    }
  }
  return { ok: true, exponent, action: 'cancelled', primeNet, prpll };
}

// ---------------------------------------------------------------- 添加

async function addTasks(rawLines) {
  const lines = Array.isArray(rawLines) ? rawLines : [rawLines];
  const cleaned = lines
    .flatMap((l) => String(l).split('\n'))
    .map((l) => l.trim())
    .filter(Boolean);

  const valid = [];
  const invalid = [];
  for (const l of cleaned) {
    const p = parseLine(l);
    if (!p) {
      invalid.push(l);
      continue;
    }
    if (findTask(p.exponent)) {
      invalid.push(l + '（指数已存在）');
      continue;
    }
    valid.push(l);
  }

  if (valid.length) {
    const target = valid.some((l) => parseLine(l)?.type === 'CERT') ? 'certwork-0.txt' : 'worktodo-0.txt';
    await withLock(dataPath(target), () => {
      appendLineToFile(target, valid.join('\n'));
    });
  }
  return { ok: true, added: valid, invalid };
}

// ---------------------------------------------------------------- 一键导入 PrimeNet 分配

/** 从 AutoPrimeNet 日志全量解析 AID -> 指数 映射 */
function buildAidMap() {
  const map = new Map();
  const logPath = dataPath('autoprimenet.log');
  const text = (() => {
    try {
      const st = fs.statSync(logPath);
      const maxBytes = 16 * 1024 * 1024;
      if (st.size > maxBytes) {
        const fd = fs.openSync(logPath, 'r');
        const buf = Buffer.alloc(maxBytes);
        const read = fs.readSync(fd, buf, 0, maxBytes, st.size - maxBytes);
        fs.closeSync(fd);
        return buf.toString('utf8', 0, read).slice(buf.toString('utf8', 0, read).indexOf('\n') + 1);
      }
      return fs.readFileSync(logPath, 'utf8');
    } catch (e) {
      return '';
    }
  })();

  for (const m of text.matchAll(/Got assignment ([0-9A-F]{32}):\s*\w+\s*M(\d+)/g)) {
    map.set(parseInt(m[2], 10), m[1]);
  }
  // 现有队列行也补一份
  for (const t of listAllTasks()) {
    if (t.aid && /^[0-9A-F]{32}$/i.test(t.aid)) map.set(t.exponent, t.aid.toUpperCase());
  }
  return map;
}

async function fetchFactoredBits(exponent) {
  const url = `https://www.mersenne.org/report_exponent_simple/?exp_lo=${exponent}&exp_hi=${exponent}&faclim=1&json=1`;
  const text = await mersenne.fetchPublicText(url);
  const json = JSON.parse(text);
  const r = json.results && json.results[0];
  return r && r.no_factor_to_bits != null ? r.no_factor_to_bits : null;
}

/** 获取 PrimeNet 上可导入（本地队列中不存在）的任务候选，不写入文件 */
async function getImportCandidates() {
  const username = getIniValue('username') || getIniValue('user_name');
  if (!username) {
    return { ok: false, error: 'prime.ini 中未找到用户名（username），无法获取 PrimeNet 分配' };
  }
  mersenne.setUsername(username);
  const mdata = await mersenne.getMersenne(false);
  const assignments = (mdata && mdata.assignments) || [];
  if (!mdata || (!mdata.ok && !assignments.length)) {
    return { ok: false, error: '无法获取 PrimeNet 分配：' + (mdata && mdata.error ? mdata.error : '无数据') };
  }

  const existing = new Set(listAllTasks().map((t) => t.exponent));
  const state = readState();
  state.paused.forEach((p) => existing.add(p.exponent));

  const aidMap = buildAidMap();
  const typeMap = { PRP: 'PRP', 'PRP-D': 'PRPDC' };
  const candidates = [];

  for (const a of assignments) {
    const exp = a.exponent;
    if (!exp || existing.has(exp)) continue;
    const type = typeMap[a.work_type];
    if (!type) continue;
    const aid = aidMap.get(exp);
    if (!aid) continue;
    let bits = 0;
    try {
      bits = await fetchFactoredBits(exp);
    } catch (e) {
      continue;
    }
    if (bits == null) continue;
    candidates.push({
      exponent: exp,
      type,
      aid,
      bits,
      line: `${type}=${aid},1,2,${exp},-1,${bits},0`,
    });
  }
  candidates.sort((a, b) => a.exponent - b.exponent);
  return { ok: true, candidates, totalAssignments: assignments.length };
}

/** 导入所选候选；selectedExponents 为空数组/未提供时导入全部候选 */
async function importFromPrimeNet(selectedExponents) {
  const prep = await getImportCandidates();
  if (!prep.ok) return prep;

  const selected = new Set(
    (Array.isArray(selectedExponents) ? selectedExponents : []).map((e) => parseInt(e, 10))
  );
  const toImport = selected.size
    ? prep.candidates.filter((c) => selected.has(c.exponent))
    : prep.candidates;

  const added = [];
  for (const c of toImport) {
    await withLock(dataPath('worktodo-0.txt'), () => {
      appendLineToFile('worktodo-0.txt', c.line);
    });
    added.push({ exponent: c.exponent, type: c.type, line: c.line });
  }
  return { ok: true, added, candidates: prep.candidates, totalAssignments: prep.totalAssignments };
}

// ---------------------------------------------------------------- 汇总

function getTasksSummary() {
  const state = readState();
  const files = [];
  for (const file of listWorkfiles()) {
    const lines = readLines(dataPath(file));
    files.push({
      file,
      lines: lines
        .map((line, i) => ({ lineNo: i + 1, line, ...(parseLine(line) || {}) }))
        .filter((l) => l.type),
    });
  }
  return {
    ok: true,
    files,
    paused: state.paused.map((p) => ({ ...p, lineNo: null })),
    stateFile: STATE_FILE,
  };
}

module.exports = {
  getTasksSummary,
  pauseTask,
  resumeTask,
  cancelTask,
  addTasks,
  getImportCandidates,
  importFromPrimeNet,
};
