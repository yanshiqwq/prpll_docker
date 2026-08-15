/**
 * PrimeNet (mersenne.org) 账户信息抓取模块
 *
 * 数据源（均为公开接口，无需登录）：
 *   - POST /assignments/  -> JSON：当前分配（权威，PrimeNet 服务器视角）
 *   - GET  /report_ll/    -> HTML：历史 LL 结果
 *   - GET  /report_prp/   -> HTML：历史 PRP 结果
 *
 * 带内存缓存（默认 10 分钟 TTL）与失败降级：抓取失败时返回上次成功的数据
 * 并标记 stale，不会让页面空白。
 */
'use strict';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const BASE = 'https://www.mersenne.org';
const TIMEOUT_MS = 20000;
const TTL_MS = 10 * 60 * 1000;

let username = '';
function setUsername(u) {
  if (u) username = u;
}

const cache = {
  data: null,
  fetchedAt: 0,
  lastError: null,
  inflight: null,
};

async function fetchText(url, opts = {}) {
  const res = await fetch(url, {
    method: opts.method || 'GET',
    headers: {
      'User-Agent': UA,
      'Accept': '*/*',
      ...(opts.headers || {}),
    },
    body: opts.body,
    redirect: 'follow',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  // mersenne.org 页面为 latin-1 编码
  return buf.toString('latin1');
}

/** 供其他模块使用的公共抓取（默认 latin-1 解码，适合 mersenne.org 页面/JSON） */
async function fetchPublicText(url) {
  return fetchText(url);
}

/** 解析 v5 server 的 key=value 响应（AutoPrimeNet 同款格式） */
function parseV5(text) {
  const out = {};
  for (const line of String(text).split('\n')) {
    if (line === '==END==') break;
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1).replace(/\r$/, '');
  }
  return out;
}

/**
 * 取消 PrimeNet 上的分配（t=au）
 * 与 AutoPrimeNet 的 assignment_unreserve 相同协议：
 * GET https://v5.mersenne.org/v5server/?px=GIMPS&v=0.95&t=au&g=<ComputerGUID>&k=<AID>&ss=19191919&sh=ABCD...
 */
async function unreserveByAid(aid, guid) {
  if (!guid) {
    return { ok: false, error: 'prime.ini 缺少 ComputerGUID，无法取消 PrimeNet 分配' };
  }
  if (!/^[0-9A-F]{32}$/i.test(String(aid || ''))) {
    return { ok: false, error: '任务缺少有效的 AID（分配键），无法同步取消 PrimeNet' };
  }
  const params = new URLSearchParams({
    px: 'GIMPS',
    v: '0.95',
    t: 'au',
    g: guid,
    k: aid,
    ss: '19191919',
    sh: 'ABCDABCDABCDABCDABCDABCDABCDABCD',
  });
  try {
    const text = await fetchText(`https://v5.mersenne.org/v5server/?${params}`);
    const resp = parseV5(text);
    const rc = parseInt(resp.pnErrorResult, 10);
    const ok = rc === 0 || rc === 43; // 43 = 无效分配键（该分配已不存在，视为成功）
    return {
      ok,
      rc,
      detail: (resp.pnErrorDetail || '').trim(),
      message: ok ? 'PrimeNet 分配已取消' : `PrimeNet 返回错误 ${rc}：${(resp.pnErrorDetail || '').trim()}`,
    };
  } catch (e) {
    return { ok: false, error: 'PrimeNet 取消请求失败：' + String(e.message || e) };
  }
}

/** 从 HTML 中解析符合期望表头的表格，返回行对象数组 */
function parseTable(html, expectHeaders) {
  const tables = [];
  const tableRe = /<table[^>]*>([\s\S]*?)<\/table>/g;
  let m;
  while ((m = tableRe.exec(html))) tables.push(m[1]);

  const clean = (s) => {
    // 优先取 title 属性（如 <td title="2026-07-27 17:15:30">2026-07-27</td>）
    const titleM = /title="([^"]+)"/.exec(s);
    if (titleM) return titleM[1].trim();
    return s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  };
  const norm = (s) => clean(s).toLowerCase().replace(/[^a-z]/g, '');
  const expect = expectHeaders.map(norm);

  for (const t of tables) {
    const rows = [...t.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((x) => x[1]);
    if (!rows.length) continue;
    const headerCells = [...rows[0].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((c) => clean(c[1]));
    const headers = headerCells.map(norm);
    if (!expect.every((h) => headers.includes(h))) continue;
    return rows.slice(1).map((r) => {
      const cells = [...r.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => clean(c[1]));
      const row = {};
      headers.forEach((h, i) => {
        row[h] = cells[i] != null ? cells[i] : '';
      });
      return row;
    });
  }
  return [];
}

/** 抓取当前分配（JSON） */
async function fetchAssignments(u) {
  const body = new URLSearchParams({
    username: u,
    f: 'j',
    exp_lo: '2',
    exp_hi: '999999999',
  }).toString();
  const text = await fetchText(`${BASE}/assignments/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = JSON.parse(text);
  return {
    assignments: Array.isArray(json.results) ? json.results : [],
    primeNetTime: json.timestamp || null,
  };
}

/** 抓取历史 LL / PRP 结果（HTML 表格 -> 统一记录） */
async function fetchResults(u) {
  const common = `user_id=${encodeURIComponent(u)}&ver=1&unv=1&bad=1&fac=1`;
  const [llHtml, prpHtml] = await Promise.all([
    fetchText(`${BASE}/report_ll/?${common}`),
    fetchText(`${BASE}/report_prp/?${common}`),
  ]);

  const llRows = parseTable(llHtml, [
    'Exponent', 'User name', 'Computer name', 'Residue', 'Software', 'Date found',
  ]);
  const prpRows = parseTable(prpHtml, [
    'Exponent', 'User name', 'Computer name', 'Residue', 'Software', 'Date found',
  ]);

  const toRecord = (row, type) => {
    const dateCell = row.datefound || '';
    const date = /^\d{4}-\d{2}-\d{2}/.exec(dateCell)?.[0] || null;
    // 生成可排序时间戳：带完整时间用其时间，仅有日期按当天 00:00:00 处理，
    // 避免无时间戳记录在排序时被排到最后导致"最近完成"取到旧记录
    let dateTs = null;
    const dt = /^(\d{4}-\d{2}-\d{2})(?: (\d{2}):(\d{2}):(\d{2}))?$/.exec(dateCell);
    if (dt) {
      const [, d, hh = '00', mm = '00', ss = '00'] = dt;
      dateTs = new Date(`${d}T${hh}:${mm}:${ss}Z`).toISOString();
    }
    return {
      type,
      exponent: parseInt(String(row.exponent || '').replace(/\s+/g, ''), 10) || null,
      user: row.username || null,
      computer: row.computername || null,
      residue: row.residue || null,
      software: row.software || null,
      date,
      dateTs,
    };
  };

  return [...llRows.map((r) => toRecord(r, 'LL')), ...prpRows.map((r) => toRecord(r, 'PRP'))];
}

function summarize(results, assignments) {
  const byType = { LL: 0, PRP: 0 };
  const byYear = {};
  const computers = new Set();
  for (const r of results) {
    if (r.type === 'LL' || r.type === 'PRP') byType[r.type]++;
    if (r.date) byYear[r.date.slice(0, 4)] = (byYear[r.date.slice(0, 4)] || 0) + 1;
    if (r.computer) computers.add(r.computer);
  }
  const sorted = [...results].sort((a, b) => (b.dateTs || '').localeCompare(a.dateTs || ''));
  return {
    total: results.length,
    ll: byType.LL,
    prp: byType.PRP,
    assignments: assignments.length,
    byYear,
    computers: [...computers],
    lastResult: sorted[0] ? { exponent: sorted[0].exponent, type: sorted[0].type, date: sorted[0].date } : null,
  };
}

async function fetchAll(u) {
  const [{ assignments, primeNetTime }, results] = await Promise.all([
    fetchAssignments(u),
    fetchResults(u),
  ]);
  const summary = summarize(results, assignments);
  const comps = new Set(assignments.map((a) => a.compid).filter(Boolean));
  summary.activeComputers = [...comps];
  return { username: u, assignments, results, summary, primeNetTime };
}

/** 获取账户数据；force=true 时忽略缓存重新抓取 */
async function getMersenne(force = false) {
  if (!username) {
    return { ok: false, error: '未在 prime.ini 中找到用户名（username）', fetchedAt: null };
  }
  const now = Date.now();
  if (!force && cache.data && now - cache.fetchedAt < TTL_MS) {
    return { ok: true, ...cache.data, cached: true, fetchedAt: cache.fetchedAt };
  }
  if (cache.inflight) return cache.inflight;

  cache.inflight = (async () => {
    try {
      const data = await fetchAll(username);
      cache.data = data;
      cache.fetchedAt = Date.now();
      cache.lastError = null;
      return { ok: true, ...data, cached: false, fetchedAt: cache.fetchedAt };
    } catch (e) {
      cache.lastError = String(e.message || e);
      if (cache.data) {
        return {
          ok: false,
          error: cache.lastError,
          stale: true,
          ...cache.data,
          fetchedAt: cache.fetchedAt,
        };
      }
      return { ok: false, error: cache.lastError, stale: false, fetchedAt: null };
    } finally {
      cache.inflight = null;
    }
  })();
  return cache.inflight;
}

function getLastError() {
  return cache.lastError;
}

/** 清除抓取缓存（取消/导入分配后调用，让下次读取立即反映最新状态） */
function clearCache() {
  cache.data = null;
  cache.fetchedAt = 0;
  cache.lastError = null;
  cache.inflight = null;
}

module.exports = { setUsername, getMersenne, getLastError, unreserveByAid, fetchPublicText, clearCache };
