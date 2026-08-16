/**
 * PRPLL(gpuowl) 日志行解析共享工具。
 *
 * server.js（实时解析）与 db.js（历史导入）共用同一组正则与时间解析，
 * 避免两份拷贝在 PRPLL 日志格式变化时产生漂移。
 */
'use strict';

/** PRP/LL 进度行：<ts> <exp> [OK] <iter> <res> <us> [ETA ...] */
const GPUOWL_PROGRESS_RE =
  /^(\d{8}) (\d{2}:\d{2}:\d{2}) +(\d+) +(?:OK +)?(\d+) +([0-9a-f]{16}) +(\d+)(?: +ETA [^;]+)?/;

/** CERT 进度行：<ts> <exp>  <iter> / <total> <res> <us> [ETA ...] */
const GPUOWL_CERT_PROGRESS_RE =
  /^(\d{8}) (\d{2}:\d{2}:\d{2}) +(\d+) +(\d+) +\/ +(\d+) +([0-9a-f]{16}) +(\d+)(?: +ETA [^;]+)?/;

/** 解析 gpuowl 时间戳 "20260813 15:43:49" -> epoch 毫秒（本地时区） */
function parseGpuowlTs(str) {
  const m = /^(\d{4})(\d{2})(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(str);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number);
  return new Date(y, mo - 1, d, h, mi, s).getTime();
}

module.exports = { GPUOWL_PROGRESS_RE, GPUOWL_CERT_PROGRESS_RE, parseGpuowlTs };
