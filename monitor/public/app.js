/* GIMPS 监控中心前端逻辑 */
'use strict';

(() => {
  const $ = (sel) => document.querySelector(sel);
  const POLL_MS = 5000;
  const LOG_LINES = 300;
  const DAY_MS = 24 * 3600 * 1000;

  let statusData = null;
  let lastHealth = null;
  let lastPrpllRunning = null;
  let apnNextCheckTs = null;
  let apnTimer = null;
  let prpllFileSig = null;
  let mersenneData = null;
  let mersenneLoaded = false;
  let histTypeFilter = 'ALL';
  let tasksData = null;
  let tasksLoaded = false;
  let cancelTarget = null;
  let pauseTarget = null;
  let pendingCancel = null;

  // ---------------------------------------------------------------- 工具函数
  const pad = (n, w = 2) => String(n).padStart(w, '0');

  function fmtClock(ts) {
    const d = new Date(ts);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  function fmtDateTime(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${fmtClock(ts)}`;
  }

  /** PrimeNet 返回的 UTC 时间字符串 -> 本地时间显示 */
  function fmtLocal(utc) {
    if (!utc) return '—';
    const d = new Date(String(utc).replace(' ', 'T') + 'Z');
    return Number.isNaN(d.getTime()) ? String(utc) : fmtDateTime(d.getTime());
  }

  function fmtNum(n) {
    if (n == null || Number.isNaN(n)) return '—';
    return Number(n).toLocaleString('zh-CN');
  }

  function fmtNumCompact(n) {
    if (n == null || Number.isNaN(n)) return '—';
    if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return String(Math.round(n));
  }

  function fmtDur(sec) {
    if (sec == null || Number.isNaN(sec)) return '—';
    sec = Math.max(0, Math.round(sec));
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const parts = [];
    if (d) parts.push(`${d}天`);
    if (h) parts.push(`${h}小时`);
    if (m) parts.push(`${m}分`);
    if (s && !d && !h) parts.push(`${s}秒`);
    return parts.join(' ') || '0秒';
  }

  function esc(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function setBadge(el, status, text) {
    el.className = 'badge ' + (status || 'neutral');
    el.textContent = text;
  }

  function kvRow(icon, k, v, extraClass = '') {
    return `<div class="kv"><div class="k"><mdui-icon name="${icon}"></mdui-icon>${k}</div><div class="v ${extraClass}">${v}</div></div>`;
  }

  function workTypeLabel(t) {
    const map = {
      PRP: 'PRP',
      'PRP-D': 'PRP 双重检查',
      PRPDC: 'PRP 双重检查',
      LL: 'LL',
      'LL-D': 'LL 双重检查',
      LLDC: 'LL 双重检查',
      CERT: '证书验证',
      TF: '试除',
      'P-1': 'P-1',
      'P+1': 'P+1',
      ECM: 'ECM',
    };
    return map[t] || t || '?';
  }

  function workTypeClass(t) {
    if (t === 'PRP-D' || t === 'PRPDC' || t === 'LL-D' || t === 'LLDC') return 'dc';
    if (t === 'CERT') return 'cert';
    return '';
  }

  // ---------------------------------------------------------------- 主题
  function applyTheme(theme) {
    const root = document.documentElement;
    root.classList.remove('mdui-theme-auto', 'mdui-theme-light', 'mdui-theme-dark');
    root.classList.add(`mdui-theme-${theme}`);
    if (window.mdui && mdui.setTheme) mdui.setTheme(theme);
    $('#themeBtn').icon = theme === 'dark' ? 'light_mode' : theme === 'light' ? 'dark_mode' : 'brightness_auto';
  }

  function initTheme() {
    const saved = localStorage.getItem('monitor-theme') || 'auto';
    applyTheme(saved);
    $('#themeBtn').addEventListener('click', () => {
      const order = ['auto', 'light', 'dark'];
      const cur = localStorage.getItem('monitor-theme') || 'auto';
      const next = order[(order.indexOf(cur) + 1) % order.length];
      localStorage.setItem('monitor-theme', next);
      applyTheme(next);
      if (window.mdui && mdui.snackbar) {
        mdui.snackbar({ message: `主题已切换为：${next === 'auto' ? '跟随系统' : next === 'dark' ? '深色' : '浅色'}` });
      }
    });
    if (window.mdui && mdui.setColorScheme) {
      mdui.setColorScheme('#1e88e5');
    }
  }

  // ---------------------------------------------------------------- 时钟与刷新
  function initClock() {
    const tick = () => {
      $('#clock').textContent = fmtClock(Date.now());
      if (apnNextCheckTs != null && $('#apnNextCheck')) {
        const remain = Math.max(0, (apnNextCheckTs - Date.now()) / 1000);
        $('#apnNextCheck').textContent = fmtDur(remain) + (remain > 0 ? ' 后' : '');
        $('#apnNextCheck').title = fmtDateTime(apnNextCheckTs);
      }
    };
    tick();
    setInterval(tick, 1000);
    $('#refreshBtn').addEventListener('click', () => {
      loadStatus(true);
    });
  }

  // ---------------------------------------------------------------- 状态渲染
  async function loadStatus(manual = false) {
    try {
      const res = await fetch('/api/status', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      statusData = await res.json();
      renderAll();
      if (manual && window.mdui && mdui.snackbar) {
        mdui.snackbar({ message: `已刷新（${fmtClock(statusData.generatedAt)}）` });
      }
    } catch (e) {
      $('#healthBadge').className = 'health-badge error';
      $('#healthBadge').textContent = '后端连接失败';
      if (manual && window.mdui && mdui.snackbar) {
        mdui.snackbar({ message: '刷新失败：' + e.message });
      }
    }
  }

  function renderAll() {
    const s = statusData;
    if (!s) return;

    // 健康徽标
    const healthMap = { ok: '运行正常', warning: '存在警告', error: '服务离线' };
    $('#healthBadge').className = 'health-badge ' + (s.health || 'ok');
    $('#healthBadge').textContent = healthMap[s.health] || s.health;
    $('#dataDir').textContent = s.dataDir;

    renderPrpll(s.prpll);
    renderApn(s.apn, s.prime);
    renderQueue(s.queue);
    renderResults(s.results);
    drawCharts(s.prpll);

    // 状态变化提醒
    if (lastHealth && lastHealth !== s.health && window.mdui && mdui.snackbar) {
      const msg =
        s.health === 'ok'
          ? '监控状态恢复正常'
          : s.health === 'warning'
            ? '监控出现警告：请检查 PRPLL / AutoPrimeNet'
            : '监控异常：PRPLL 或 AutoPrimeNet 已离线';
      mdui.snackbar({ message: msg });
    }
    lastHealth = s.health;

    const prpllRunning = s.prpll.workers.some((w) => w.running);
    if (lastPrpllRunning === false && prpllRunning && window.mdui && mdui.snackbar) {
      mdui.snackbar({ message: 'PRPLL 已恢复计算' });
    }
    lastPrpllRunning = prpllRunning;
  }

  // ---- PRPLL ----
  function renderPrpll(prpll) {
    setBadge($('#prpllStatus'), prpll.status, statusLabel(prpll.status));
    $('#prpllStatus').title = prpll.statusNote || '';

    const box = $('#prpllWorkers');
    if (!prpll.workers || !prpll.workers.length) {
      box.innerHTML = `<div class="empty">${esc(prpll.statusNote || '未找到日志')}</div>`;
      return;
    }

    box.innerHTML = prpll.workers.map((w) => workerBlock(w)).join('');

    // 日志选择器（多 worker 时显示）
    const select = $('#prpllLogSelect');
    const files = prpll.files || [];
    const sig = files.map((f) => f.name).join('|');
    if (files.length > 1) {
      if (sig !== prpllFileSig) {
        const current = select.value && files.some((f) => f.name === select.value) ? select.value : files[0].name;
        select.innerHTML = files
          .map((f) => `<mdui-menu-item value="${esc(f.name)}">${esc(f.name)}</mdui-menu-item>`)
          .join('');
        select.value = current;
        prpllFileSig = sig;
      }
      select.classList.remove('hidden');
    } else {
      prpllFileSig = null;
      select.classList.add('hidden');
    }
  }

  function statusLabel(status) {
    return status === 'running' ? '运行中' : status === 'warning' ? '警告' : status === 'stopped' ? '已停止' : '未知';
  }

  function workerBlock(w) {
    const running = w.status === 'running';
    const pct = w.percent != null ? w.percent : null;
    const rows = [];

    if (w.exponent) {
      rows.push(
        `<div class="worker-head">
          <span class="worker-title">Worker ${w.worker} · M<span class="exp">${fmtNum(w.exponent)}</span></span>
          <span class="worker-note">${esc(w.statusNote || '')}</span>
        </div>
        <div class="progress-row">
          <mdui-linear-progress value="${(pct != null ? pct : 0) / 100}"></mdui-linear-progress>
          <span class="progress-pct">${pct != null ? pct.toFixed(2) : '0.00'}%</span>
        </div>`
      );
      rows.push(
        `<div class="kv-list">
          ${kvRow('pin', '迭代进度', `<b>${fmtNum(w.iteration)}</b> / ${fmtNum(w.exponent)}`)}
          ${kvRow('timer', '预计完成', w.etaSec != null ? `<span class="timer">${fmtDur(w.etaSec)}</span><br><small style="font-weight:400">${fmtDateTime(w.etaAt)}</small>` : '—')}
          ${kvRow('bolt', '计算速度', w.itersPerSec != null ? `${w.itersPerSec.toFixed(1)} 迭代/秒` : '—')}
          ${kvRow('hourglass_top', '单次迭代', w.usPerIter != null ? `${fmtNum(w.usPerIter)} µs` : '—')}
          ${kvRow('trending_up', '每日进度', w.percentPerDay != null ? `${w.percentPerDay.toFixed(2)}%/天` : '—')}
          ${kvRow('data_object', 'FFT', esc(w.fft || '—'))}
          ${kvRow('verified', '最近校验', w.lastOk ? `迭代 ${fmtNum(w.lastOk.iteration)}<br><small style="font-weight:400">${esc(w.lastOk.at || '')}${w.lastOk.z != null ? ' · Z=' + fmtNum(w.lastOk.z) : ''}</small>` : '—')}
          ${kvRow('key', '证明文件', w.proofPower != null ? `${fmtNum(w.proofCount || 0)} / ${Math.pow(2, w.proofPower)} 块（2^${w.proofPower}）` : '—')}
          ${kvRow('history', '本次运行', w.sessionSinceSec != null ? fmtDur(w.sessionSinceSec) : '—')}
          ${kvRow('restart_alt', '重启次数', fmtNum(w.startCount || 0))}
          ${kvRow('memory', '设备', esc(w.device || '—'))}
        </div>`
      );
    } else {
      rows.push(`<div class="worker-head"><span class="worker-title">Worker ${w.worker}</span><span class="worker-note">${esc(w.statusNote)}</span></div>`);
      rows.push(`<div class="empty">${running ? '正在初始化 / 等待任务…' : esc(w.statusNote)}</div>`);
    }

    if (w.warningCount) {
      rows.push(
        w.warnings
          .map((x) => `<div class="warn-row ${/error|stuck|abort/i.test(x) ? 'error' : ''}">${esc(x)}</div>`)
          .join('')
      );
    }
    return `<div class="worker-block">${rows.join('')}</div>`;
  }

  // ---- AutoPrimeNet ----
  function renderApn(apn, prime) {
    setBadge($('#apnStatus'), apn.status, statusLabel(apn.status));
    $('#apnStatus').title = apn.statusNote || '';

    apnNextCheckTs = apn.nextCheck ? new Date(apn.nextCheck.replace(' ', 'T')).getTime() : null;

    let html = `<div class="kv-list">`;
    html += kvRow('person', 'PrimeNet 用户', esc(apn.user || '—'));
    html += kvRow('desktop_windows', '设备', esc(apn.cpuBrand || '—'));
    html += kvRow('schedule', '上次签到', esc(apn.lastCheck || '—'));
    html += kvRow('event_available', '下次签到', apn.nextCheck ? `<span class="timer" id="apnNextCheck">…</span><br><small style="font-weight:400">${esc(apn.nextCheck)}</small>` : '—');
    html += kvRow('autorenew', '检查间隔', apn.checkIntervalH ? `${apn.checkIntervalH} 小时` : '—');
    html += kvRow(
      'hourglass_bottom',
      '队列预计耗时',
      apn.queueEtaSec != null
        ? `<b>${fmtDur(apn.queueEtaSec)}</b><br><small style="font-weight:400">${fmtDateTime(apn.queueEtaAt)} 完成全部队列</small>`
        : esc(apn.queueEta || '—')
    );
    html += kvRow('analytics', '30 天滚动平均', apn.rollingAverage != null ? fmtNum(apn.rollingAverage) + ' GHz·天/天' : '—');
    html += kvRow('memory', '单次迭代', apn.msecPerIter != null ? `${apn.msecPerIter} ms` : '—');
    html += kvRow('info', '版本', esc(apn.version || '—'));
    html += kvRow('folder', '监控目录', esc(apn.watcher || '—'));
    html += `</div>`;

    if (apn.assignments && apn.assignments.length) {
      html += `<div class="sub-list"><div class="sub-list-title">当前分配（${apn.assignments.length}）</div>`;
      for (const a of apn.assignments) {
        const typeClass = a.worktype === 'PRPDC' ? 'dc' : a.worktype === 'CERT' ? 'cert' : '';
        html += `<div class="sub-row">
          <span class="type-badge ${typeClass}">${esc(a.worktype || '?')}</span>
          <div class="main">
            <div class="t1">M${fmtNum(a.exponent)}</div>
            <div class="t2">${esc(a.doneDate || '')}${a.aid ? ' · ' + esc(a.aid.slice(0, 8)) + '…' : ''}</div>
          </div>
          <div class="right">${esc(a.etaText || '—')}</div>
        </div>`;
      }
      html += `</div>`;
    }

    if (apn.warningCount) {
      html += `<div class="sub-list"><div class="sub-list-title">最近警告（${apn.warningCount}）</div>`;
      for (const w of apn.warnings) {
        html += `<div class="warn-row ${w.level === 'ERROR' ? 'error' : ''}">${esc(w.text)}</div>`;
      }
      html += `</div>`;
    }

    $('#apnBody').innerHTML = html;
  }

  // ---- 工作队列 ----
  function renderQueue(queue) {
    $('#queueSummary').textContent = queue.length ? `共 ${queue.length} 个任务` : '暂无任务';
    const box = $('#queueList');
    if (!queue.length) {
      box.innerHTML = `<div class="empty">工作队列为空</div>`;
      return;
    }
    box.innerHTML = queue
      .map((q, i) => {
        const typeClass = q.worktype === 'PRPDC' ? 'dc' : q.worktype === 'CERT' ? 'cert' : '';
        return `<div class="sub-row">
          <span class="type-badge ${typeClass}">${esc(q.worktypeLabel || q.worktype)}</span>
          <div class="main">
            <div class="t1">M${fmtNum(q.exponent)}</div>
            <div class="t2">${esc(q.file)} · 已试除 ${fmtNum(q.bits)} bits${q.aid ? ' · ' + esc(q.aid.slice(0, 8)) + '…' : ''}</div>
          </div>
          <div class="right">#${i + 1}</div>
        </div>`;
      })
      .join('');
  }

  // ---- 最近结果 ----
  function renderResults(results) {
    $('#resultsSummary').textContent = results.length ? `最近 ${results.length} 条` : '暂无结果';
    const box = $('#resultsList');
    if (!results.length) {
      box.innerHTML = `<div class="empty">暂无已完成的结果</div>`;
      return;
    }
    const statusMap = {
      C: { cls: '', text: '合数' },
      P: { cls: 'prime', text: '素数!' },
      F: { cls: 'factor', text: '因子' },
      NF: { cls: 'factor', text: '无因子' },
      LL: { cls: '', text: 'LL' },
    };
    box.innerHTML = results
      .map((r) => {
        const st = statusMap[r.status] || { cls: '', text: r.status || '?' };
        return `<div class="sub-row">
          <span class="result-status ${st.cls}" title="${esc(st.text)}">${esc(st.text.charAt(0))}</span>
          <div class="main">
            <div class="t1">M${fmtNum(r.exponent)}</div>
            <div class="t2">${esc(r.timestamp || '')} · ${esc(r.worktype || '')} · ${esc(r.program || '')}${r.errors != null ? ` · Gerbicz 错误 ${r.errors}` : ''}</div>
          </div>
          <div class="right mono">${esc((r.res64 || '').slice(0, 12))}</div>
        </div>`;
      })
      .join('');
  }

  // ---------------------------------------------------------------- 图表
  function drawCharts(prpll) {
    const worker = prpll.workers && prpll.workers[0];
    if (!worker) {
      drawEmptyChart($('#progressChart'), '暂无数据');
      drawEmptyChart($('#speedChart'), '暂无数据');
      return;
    }
    const progress = worker.history ? worker.history.progress : [];
    const speed = worker.history ? worker.history.speed : [];

    drawLineChart($('#progressChart'), progress, {
      yMin: 0,
      yMax: 100,
      yFmt: (v) => v.toFixed(0) + '%',
      label: worker.exponent ? `M${fmtNumCompact(worker.exponent)}` : '',
      emptyText: '暂无进度数据',
    });

    const dayAgo = Date.now() - DAY_MS;
    const speed24 = speed.filter((p) => p[0] >= dayAgo);
    drawLineChart($('#speedChart'), speed24, {
      yFmt: (v) => fmtNumCompact(v) + '/s',
      label: worker.itersPerSec != null ? `${worker.itersPerSec.toFixed(1)} 迭代/秒` : '',
      emptyText: '24 小时内暂无数据',
      showAvg: true,
    });
  }

  function drawEmptyChart(canvas, text) {
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || canvas.parentElement.clientWidth;
    canvas.width = w * dpr;
    canvas.height = 220 * dpr;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, 220);
    ctx.fillStyle = cssVar('--mdui-color-on-surface-variant');
    ctx.font = '14px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(text, w / 2, 110);
  }

  function cssVar(name) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v ? `rgb(${v})` : '#888';
  }

  function drawLineChart(canvas, points, opts) {
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || canvas.parentElement.clientWidth || 400;
    const h = 220;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    if (!points || points.length < 2) {
      drawEmptyChart(canvas, opts.emptyText || '暂无数据');
      return;
    }

    const padL = 48;
    const padR = 12;
    const padT = 14;
    const padB = 26;
    const iw = w - padL - padR;
    const ih = h - padT - padB;

    const t0 = points[0][0];
    const t1 = points[points.length - 1][0];
    const yMin = opts.yMin != null ? opts.yMin : Math.min(0, ...points.map((p) => p[1])) * 0.9;
    const yMax = opts.yMax != null ? opts.yMax : Math.max(...points.map((p) => p[1])) * 1.1;
    const span = Math.max(1, t1 - t0);
    const x = (t) => padL + ((t - t0) / span) * iw;
    const y = (v) => padT + (1 - (v - yMin) / (yMax - yMin || 1)) * ih;

    // 网格与坐标轴
    const gridColor = cssVar('--mdui-color-outline-variant');
    const textColor = cssVar('--mdui-color-on-surface-variant');
    ctx.font = '11px sans-serif';
    ctx.strokeStyle = gridColor;
    ctx.lineWidth = 1;
    ctx.fillStyle = textColor;
    ctx.textAlign = 'right';

    const rows = 4;
    for (let i = 0; i <= rows; i++) {
      const v = yMin + ((yMax - yMin) * i) / rows;
      const yy = y(v);
      ctx.beginPath();
      ctx.moveTo(padL, yy);
      ctx.lineTo(w - padR, yy);
      ctx.stroke();
      ctx.fillText(opts.yFmt ? opts.yFmt(v) : v.toFixed(1), padL - 6, yy + 4);
    }

    const cols = Math.min(6, Math.max(3, Math.floor(iw / 90)));
    ctx.textAlign = 'center';
    for (let i = 0; i <= cols; i++) {
      const t = t0 + (span * i) / cols;
      const xx = x(t);
      ctx.beginPath();
      ctx.moveTo(xx, padT);
      ctx.lineTo(xx, h - padB);
      ctx.stroke();
      ctx.fillText(fmtClock(t), xx, h - 8);
    }

    // 平均线
    let avg = null;
    if (opts.showAvg) {
      avg = points.reduce((s, p) => s + p[1], 0) / points.length;
      ctx.strokeStyle = cssVar('--mdui-color-tertiary');
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(padL, y(avg));
      ctx.lineTo(w - padR, y(avg));
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // 数据线 + 渐变面积
    const lineColor = cssVar('--mdui-color-primary');
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 2;
    ctx.beginPath();
    points.forEach((p, i) => (i ? ctx.lineTo(x(p[0]), y(p[1])) : ctx.moveTo(x(p[0]), y(p[1]))));
    ctx.stroke();

    const grad = ctx.createLinearGradient(0, padT, 0, h - padB);
    grad.addColorStop(0, 'rgba(33, 150, 243, 0.18)');
    grad.addColorStop(1, 'rgba(33, 150, 243, 0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(x(points[0][0]), h - padB);
    points.forEach((p) => ctx.lineTo(x(p[0]), y(p[1])));
    ctx.lineTo(x(points[points.length - 1][0]), h - padB);
    ctx.closePath();
    ctx.fill();

    // 末点标注
    const last = points[points.length - 1];
    ctx.fillStyle = lineColor;
    ctx.beginPath();
    ctx.arc(x(last[0]), y(last[1]), 3.5, 0, Math.PI * 2);
    ctx.fill();

    if (opts.label) {
      ctx.fillStyle = textColor;
      ctx.textAlign = 'left';
      ctx.font = 'bold 11px sans-serif';
      ctx.fillText(opts.label, padL, padT - 3);
    }
  }

  // ---------------------------------------------------------------- PrimeNet 账户 / 历史任务
  async function loadMersenne(force = false) {
    if (mersenneLoaded && !force && mersenneData) return;
    setBadge($('#pnStatus'), 'neutral', '加载中…');
    try {
      const url = force ? '/api/mersenne/refresh' : '/api/mersenne';
      const res = await fetch(url, { method: force ? 'POST' : 'GET', cache: 'no-store' });
      mersenneData = await res.json();
      mersenneLoaded = true;
      renderMersenne();
    } catch (e) {
      setBadge($('#pnStatus'), 'error', '请求失败');
      $('#pnBody').innerHTML = `<div class="empty">无法获取 PrimeNet 数据：${esc(e.message)}</div>`;
    }
  }

  function renderMersenne() {
    const d = mersenneData;
    if (!d) return;

    if (d.ok) {
      setBadge($('#pnStatus'), 'ok', '已连接');
    } else if (d.stale) {
      setBadge($('#pnStatus'), 'warning', '数据过期');
    } else {
      setBadge($('#pnStatus'), 'error', '不可用');
    }

    const staleTip = $('#pnStale');
    if (!d.ok) {
      staleTip.classList.remove('hidden');
      staleTip.innerHTML = `PrimeNet 抓取失败：${esc(d.error || '未知错误')}${d.fetchedAt ? `。以下为 ${fmtDateTime(d.fetchedAt)} 的缓存数据` : ''}`;
    } else {
      staleTip.classList.add('hidden');
    }

    const fetchedAgo = d.fetchedAt ? Math.round((Date.now() - d.fetchedAt) / 1000) : null;
    const user = d.username || '—';
    const summary = d.summary || {};
    const activeComps = (summary.activeComputers || []).join('、') || '—';
    const allComps = (summary.computers || []).join('、') || '—';

    $('#pnBody').innerHTML = `
      <div class="kv-list">
        ${kvRow('person', '用户名', esc(user))}
        ${kvRow('desktop_windows', '活跃计算机', esc(activeComps))}
        ${kvRow('dns', 'PrimeNet 时间', esc(d.primeNetTime ? fmtLocal(d.primeNetTime.replace('T', ' ').slice(0, 19)) : '—'))}
        ${kvRow('update', '数据抓取时间', d.fetchedAt ? `${fmtDateTime(d.fetchedAt)}${fetchedAgo != null ? `（${fmtDur(fetchedAgo)} 前）` : ''}` : '—')}
        ${kvRow('verified', '历史结果', `${fmtNum(summary.total || 0)} 条（LL ${fmtNum(summary.ll || 0)} · PRP ${fmtNum(summary.prp || 0)}）`)}
        ${kvRow('event', '最近完成', summary.lastResult ? `M${fmtNum(summary.lastResult.exponent)}（${esc(summary.lastResult.type)} · ${esc(summary.lastResult.date || '')}）` : '—')}
      </div>
    `;

    renderAssignments(d.assignments || []);

    const years = Object.entries(summary.byYear || {})
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([y, n]) => `${y} 年：${n} 条`)
      .join('<br>');
    $('#pnStatsSummary').textContent = summary.total ? `共 ${summary.total} 条结果` : '暂无结果';
    $('#pnStats').innerHTML = `
      <div class="kv-list">
        ${kvRow('fact_check', '结果总数', fmtNum(summary.total || 0))}
        ${kvRow('memory', 'LL 结果', fmtNum(summary.ll || 0))}
        ${kvRow('science', 'PRP 结果', fmtNum(summary.prp || 0))}
        ${kvRow('desktop_windows', '历史计算机', esc(allComps))}
        ${kvRow('calendar_month', '按年份', years || '—')}
      </div>
    `;

    renderHistoryTable();
  }

  function renderAssignments(assignments) {
    $('#pnAssignSummary').textContent = assignments.length ? `共 ${assignments.length} 个未完成分配` : '当前无分配';
    const box = $('#pnAssignList');
    if (!assignments.length) {
      box.innerHTML = `<div class="empty">PrimeNet 当前没有分配任务</div>`;
      return;
    }
    box.innerHTML = assignments
      .slice()
      .sort((a, b) => a.exponent - b.exponent)
      .map((a) => {
        const pct = a.percent_done != null ? +a.percent_done : null;
        const bar = pct != null
          ? `<mdui-linear-progress value="${Math.min(100, Math.max(0, pct)) / 100}"></mdui-linear-progress>`
          : '';
        const etaText = a.eta_days != null && a.eta_days > 0 ? `约 ${fmtDur(a.eta_days * 86400)}` : pct != null && pct >= 99 ? '即将完成' : '—';
        return `<div class="sub-row assign-row">
          <span class="type-badge ${workTypeClass(a.work_type)}">${esc(workTypeLabel(a.work_type))}</span>
          <div class="main">
            <div class="t1">M${fmtNum(a.exponent)}</div>
            <div class="t2">分配 ${esc(fmtLocal(a.assigned))} · 更新 ${esc(fmtLocal(a.updated))}${a.expire_days != null ? ` · ${fmtNum(a.expire_days)} 天后过期` : ''}</div>
            ${pct != null ? `<div class="assign-bar">${bar}<span class="assign-pct">${pct.toFixed(1)}%</span></div>` : ''}
          </div>
          <div class="right">
            <div class="t1">${esc(fmtLocal(a.completion))}</div>
            <div class="t2">${etaText}</div>
          </div>
        </div>`;
      })
      .join('');
  }

  function renderHistoryTable() {
    const d = mersenneData;
    const body = $('#histBody');
    const countEl = $('#histCount');
    if (!d || !d.results) {
      body.innerHTML = `<tr class="empty-row"><td colspan="6">暂无数据</td></tr>`;
      countEl.textContent = '';
      return;
    }
    const keyword = ($('#histFilter').value || '').trim().toLowerCase();
    const rows = (d.results || [])
      .filter((r) => histTypeFilter === 'ALL' || r.type === histTypeFilter)
      .filter((r) => {
        if (!keyword) return true;
        return (
          String(r.exponent || '').includes(keyword) ||
          String(r.residue || '').toLowerCase().includes(keyword) ||
          String(r.computer || '').toLowerCase().includes(keyword) ||
          String(r.date || '').includes(keyword)
        );
      })
      .sort((a, b) => (b.dateTs || b.date || '').localeCompare(a.dateTs || a.date || ''));

    countEl.textContent = `共 ${d.results.length} 条，显示 ${rows.length} 条`;
    if (!rows.length) {
      body.innerHTML = `<tr class="empty-row"><td colspan="6">没有匹配的任务</td></tr>`;
      return;
    }
    body.innerHTML = rows
      .map(
        (r) => `<tr>
          <td><span class="type-badge ${workTypeClass(r.type)}">${esc(r.type || '?')}</span></td>
          <td><a class="exp-link" href="https://www.mersenne.org/M${r.exponent}" target="_blank" rel="noopener">M${fmtNum(r.exponent)}</a></td>
          <td class="residue">${esc(r.residue || '—')}</td>
          <td>${esc(r.computer || '—')}</td>
          <td>${esc(r.software || '—')}</td>
          <td>${esc(r.dateTs ? fmtLocal(r.dateTs.slice(0, 19)) : r.date || '—')}</td>
        </tr>`
      )
      .join('');
  }

  function initMersenne() {
    $('#pnRefreshBtn').addEventListener('click', () => {
      loadMersenne(true).then(() => {
        if (window.mdui && mdui.snackbar) {
          mdui.snackbar({ message: mersenneData && mersenneData.ok ? 'PrimeNet 数据已刷新' : 'PrimeNet 刷新失败，已显示缓存' });
        }
      });
    });

    $('#histFilter').addEventListener('input', renderHistoryTable);
    $('#histTypeFilter').addEventListener('click', (e) => {
      const chip = e.target.closest('.type-chip');
      if (!chip) return;
      document.querySelectorAll('#histTypeFilter .type-chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      histTypeFilter = chip.dataset.type;
      renderHistoryTable();
    });

    // 预取，进入页面即可见
    loadMersenne(false);
  }

  // ---------------------------------------------------------------- 任务队列管理
  async function loadTasks() {
    try {
      const res = await fetch('/api/tasks', { cache: 'no-store' });
      tasksData = await res.json();
      tasksLoaded = true;
      renderTasks();
    } catch (e) {
      const box = $('#taskFiles');
      if (box) box.innerHTML = `<div class="empty">无法获取任务队列：${esc(e.message)}</div>`;
    }
  }

  function runningExponent() {
    const w = statusData && statusData.prpll && statusData.prpll.workers && statusData.prpll.workers[0];
    return w && w.exponent ? w.exponent : null;
  }

  function taskRowHtml(t, actions, running) {
    const isRunning = running && t.exponent === running;
    return `<div class="sub-row task-row ${isRunning ? 'running' : ''}">
      <span class="type-badge ${workTypeClass(t.type)}">${esc(workTypeLabel(t.type))}</span>
      <div class="main">
        <div class="t1">M${fmtNum(t.exponent)}${isRunning ? '<span class="running-tag">运行中</span>' : ''}</div>
        <div class="t2">${esc(t.file || '')}${t.lineNo ? ' · 第 ' + t.lineNo + ' 行' : ''}${t.bits != null ? ' · 已试除 ' + fmtNum(t.bits) + ' bits' : ''}${t.aid && /^[0-9A-F]{32}$/i.test(t.aid) ? ' · ' + esc(t.aid.slice(0, 8)) + '…' : ''}</div>
      </div>
      <div class="task-actions">${actions}</div>
    </div>`;
  }

  function renderTasks() {
    const d = tasksData;
    if (!d || !d.ok) return;
    const running = runningExponent();
    const all = d.files.reduce((acc, f) => acc.concat(f.lines.map((l) => ({ ...l }))), []);
    const paused = d.paused || [];
    $('#taskCount').textContent = `队列 ${all.length} 个 · 已暂停 ${paused.length} 个`;
    $('#pausedTitle').textContent = `已暂停（${paused.length}）`;

    const filesBox = $('#taskFiles');
    if (!all.length) {
      filesBox.innerHTML = `<div class="empty">工作队列为空</div>`;
    } else {
      filesBox.innerHTML = d.files
        .map((f) => {
          const rows = f.lines
            .map((t) =>
              taskRowHtml(
                t,
                `<mdui-button-icon data-action="pause" data-exp="${t.exponent}" icon="pause" title="暂停（本地队列移除，可在暂停列表恢复）"></mdui-button-icon>
                 <mdui-button-icon data-action="cancel" data-exp="${t.exponent}" icon="delete" title="取消任务"></mdui-button-icon>`,
                running
              )
            )
            .join('');
          return `<div class="sub-list"><div class="sub-list-title">${esc(f.file)}（${f.lines.length}）</div>${rows}</div>`;
        })
        .join('');
    }

    const pausedBox = $('#taskPaused');
    if (!paused.length) {
      pausedBox.innerHTML = `<div class="empty">没有已暂停的任务</div>`;
    } else {
      pausedBox.innerHTML = paused
        .map((p) =>
          taskRowHtml(
            p,
            `<mdui-button-icon data-action="resume" data-exp="${p.exponent}" icon="play_arrow" title="恢复（加回队列末尾）"></mdui-button-icon>
             <mdui-button-icon data-action="cancel" data-exp="${p.exponent}" icon="delete" title="取消任务"></mdui-button-icon>`,
            running
          )
        )
        .join('');
    }
  }

  async function apiTask(action, payload) {
    const res = await fetch(`/api/tasks/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return res.json();
  }

  function showTaskResult(r, okMsg) {
    if (!window.mdui || !mdui.snackbar) return;
    if (r && r.ok) {
      mdui.snackbar({ message: okMsg });
    } else {
      mdui.snackbar({ message: (r && r.error) || '操作失败' });
    }
  }

  function initTasks() {
    // 添加任务对话框
    $('#taskAddBtn').addEventListener('click', () => {
      $('#addTaskInput').value = '';
      $('#addTaskDialog').open = true;
    });
    $('#addTaskCancel').addEventListener('click', () => {
      $('#addTaskDialog').open = false;
    });
    $('#addTaskConfirm').addEventListener('click', async () => {
      const lines = ($('#addTaskInput').value || '')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      if (!lines.length) {
        mdui.snackbar({ message: '请输入至少一行任务' });
        return;
      }
      const r = await apiTask('add', { lines });
      $('#addTaskDialog').open = false;
      showTaskResult(r, `已添加 ${(r.added || []).length} 个任务`);
      if (r.invalid && r.invalid.length && window.mdui) {
        mdui.snackbar({ message: `${r.invalid.length} 行无效：${r.invalid[0]}` });
      }
      loadTasks();
    });

    // 取消任务对话框
    $('#cancelTaskCancel').addEventListener('click', () => {
      $('#cancelTaskDialog').open = false;
    });
    $('#cancelTaskConfirm').addEventListener('click', async () => {
      if (!cancelTarget) return;
      const exp = cancelTarget.exponent;
      const unreserve = $('#cancelUnreserve').checked;
      const immediate = $('#cancelImmediate').checked;
      $('#cancelTaskDialog').open = false;
      cancelTarget = null;
      if (unreserve) {
        // 不可撤销操作：二次确认
        pendingCancel = { exponent: exp, unreserve, immediate };
        $('#confirm2Dialog').open = true;
      } else {
        await doCancel(exp, unreserve, immediate);
      }
    });

    $('#confirm2Cancel').addEventListener('click', () => {
      $('#confirm2Dialog').open = false;
      pendingCancel = null;
    });
    $('#confirm2Ok').addEventListener('click', async () => {
      const p = pendingCancel;
      $('#confirm2Dialog').open = false;
      pendingCancel = null;
      if (p) await doCancel(p.exponent, p.unreserve, p.immediate);
    });

    async function doCancel(exp, unreserve, immediate) {
      const r = await apiTask('cancel', {
        exponent: exp,
        unreserve,
        immediate,
      });
      const base = `已取消 M${fmtNum(r.exponent || exp)}${immediate && r.prpll ? '（立即生效）' : ''}`;
      showTaskResult(r, base);
      if (r && r.primeNet && !r.primeNet.ok) {
        mdui.snackbar({ message: r.primeNet.error || r.primeNet.message || 'PrimeNet 同步取消失败' });
      }
      if (r && r.prpll && !r.prpll.ok) {
        mdui.snackbar({ message: '任务已处理，但无法中断 PRPLL：' + (r.prpll.error || '未知错误') });
      } else if (r && r.prpll && r.prpll.note && window.mdui) {
        mdui.snackbar({ message: r.prpll.note });
      }
      loadTasks();
    }

    // 暂停任务对话框
    $('#pauseTaskCancel').addEventListener('click', () => {
      $('#pauseTaskDialog').open = false;
      pauseTarget = null;
    });
    $('#pauseTaskConfirm').addEventListener('click', async () => {
      if (!pauseTarget) return;
      const exp = pauseTarget.exponent;
      const immediate = $('#pauseImmediate').checked;
      $('#pauseTaskDialog').open = false;
      pauseTarget = null;
      const r = await apiTask('pause', { exponent: exp, immediate });
      showTaskResult(r, `已暂停 M${fmtNum(exp)}${immediate && r.prpll ? '（立即生效）' : ''}，可在暂停列表恢复`);
      if (r && r.prpll && !r.prpll.ok) {
        mdui.snackbar({ message: '任务已暂停，但无法中断 PRPLL：' + (r.prpll.error || '未知错误') });
      } else if (r && r.prpll && r.prpll.note && window.mdui) {
        mdui.snackbar({ message: r.prpll.note });
      }
      loadTasks();
    });

    // 行内操作（事件委托）
    const handleAction = async (e) => {
      const btn = e.target.closest('mdui-button-icon[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;
      const exp = parseInt(btn.dataset.exp, 10);
      if (action === 'pause') {
        pauseTarget = { exponent: exp };
        const isRunning = exp === runningExponent();
        $('#pauseTaskInfo').innerHTML =
          `确定暂停 <b>M${fmtNum(exp)}</b> 吗？将从工作队列移除并加入暂停列表。` +
          (isRunning ? '<br><b>该任务正在运行</b>，默认在完成当前指数后才生效。' : '<br>该任务尚未运行，暂停立即生效。');
        $('#pauseImmediateBox').classList.toggle('hidden', !isRunning);
        $('#pauseImmediate').checked = false;
        $('#pauseTaskDialog').open = true;
      } else if (action === 'resume') {
        const r = await apiTask('resume', { exponent: exp });
        showTaskResult(r, `已恢复 M${fmtNum(exp)}（加回队列末尾）`);
        loadTasks();
      } else if (action === 'cancel') {
        cancelTarget = { exponent: exp };
        const isRunning = exp === runningExponent();
        $('#cancelTaskInfo').innerHTML =
          `确定取消 <b>M${fmtNum(exp)}</b> 吗？将从工作队列中移除。` +
          (isRunning ? '<br><b>该任务正在运行</b>，默认在完成当前指数后才生效。' : '');
        $('#cancelUnreserve').checked = true;
        $('#cancelImmediateBox').classList.toggle('hidden', !isRunning);
        $('#cancelImmediate').checked = false;
        $('#cancelTaskDialog').open = true;
      }
    };
    $('#taskFiles').addEventListener('click', handleAction);
    $('#taskPaused').addEventListener('click', handleAction);

    // 一键导入
    $('#taskImportBtn').addEventListener('click', async () => {
      const btn = $('#taskImportBtn');
      btn.loading = true;
      try {
        const r = await fetch('/api/tasks/import', { method: 'POST' }).then((x) => x.json());
        const tip = $('#taskTip');
        if (r && r.ok) {
          tip.classList.remove('hidden');
          tip.innerHTML =
            `导入完成：新增 ${(r.added || []).length} 个任务` +
            ((r.skipped || []).length
              ? `，跳过 ${r.skipped.length} 个：${r.skipped.map((s) => `M${s.exponent}（${esc(s.reason)}）`).join('、')}`
              : '');
          if (window.mdui) mdui.snackbar({ message: `已从 PrimeNet 导入 ${(r.added || []).length} 个任务` });
        } else {
          tip.classList.remove('hidden');
          tip.innerHTML = `导入失败：${esc((r && r.error) || '未知错误')}`;
        }
        loadTasks();
      } catch (e) {
        if (window.mdui) mdui.snackbar({ message: '导入请求失败：' + e.message });
      } finally {
        btn.loading = false;
      }
    });

    // 懒加载：首次进入账户 / 历史 / 任务页时拉取
    $('#mainTabs').addEventListener('change', () => {
      const v = $('#mainTabs').value;
      if (v === 'tasks' && !tasksLoaded) loadTasks();
      if ((v === 'account' || v === 'history') && !mersenneLoaded) loadMersenne(false);
    });
  }

  // ---------------------------------------------------------------- 日志（SSE）
  function connectLogStream(cfg) {
    const { kind, select, filterEl, autoEl, preEl, statusEl, btnCopy, btnClear, buildUrl } = cfg;
    let source = null;
    let timer = null;
    let lastText = '';
    let live = false;
    let currentName = '';

    const render = (lines) => {
      const keyword = filterEl.value.trim();
      let re = null;
      if (keyword) {
        try {
          re = new RegExp(keyword, 'i');
        } catch (e) {
          re = null;
        }
      }
      const visible = re ? lines.filter((l) => re.test(l.text)) : lines;
      const html = visible.map((l) => `<span class="log-line ${l.level}">${esc(l.text)}</span>`).join('\n');
      if (html) preEl.innerHTML = html;
      else preEl.innerHTML = '<span class="log-line info">（无匹配行）</span>';
      lastText = lines.map((l) => l.text).join('\n');
      const total = lines.length;
      updateStatus(visible.length === total ? `共 ${total} 行` : `显示 ${visible.length} / ${total} 行`);
      if (autoEl.checked) preEl.scrollTop = preEl.scrollHeight;
    };

    const updateStatus = (msg) => {
      statusEl.className = 'log-status ' + (live ? 'live' : 'dead');
      statusEl.innerHTML = `<span><span class="dot"></span>${live ? '实时推送中' : '已断开，重连中…'} · ${esc(msg || '')}</span><span>${esc(currentName)}</span>`;
    };

    const connect = (name) => {
      if (source) source.close();
      currentName = name;
      live = false;
      updateStatus('连接中…');

      source = new EventSource(buildUrl(name));
      source.onopen = () => {
        live = true;
        updateStatus('已连接');
      };
      source.addEventListener('snapshot', (e) => {
        const data = JSON.parse(e.data);
        if (data && data.lines) render(data.lines);
        live = true;
      });
      source.addEventListener('lines', (e) => {
        const data = JSON.parse(e.data);
        if (data && data.lines && data.lines.length) {
          const extra = data.lines.map((l) => ({ level: l.level, text: l.text }));
          if (autoEl.checked && !filterEl.value.trim()) {
            // 直接追加，性能更好
            const frag = extra.map((l) => `<span class="log-line ${l.level}">${esc(l.text)}</span>`).join('\n');
            preEl.insertAdjacentHTML('beforeend', '\n' + frag);
            preEl.scrollTop = preEl.scrollHeight;
            lastText += '\n' + extra.map((l) => l.text).join('\n');
            updateStatus(`共 ${preEl.querySelectorAll('.log-line').length} 行`);
          } else {
            // 有过滤时重建
            const all = parseCurrent(preEl);
            all.push(...extra);
            render(all);
          }
        }
      });
      source.addEventListener('rotated', () => {
        lastText = '';
      });
      source.addEventListener('error', (e) => {
        live = false;
        updateStatus('连接中断');
        // EventSource 自动重连（retry: 3000）
      });
      source.onerror = () => {
        live = false;
        updateStatus('连接中断');
      };
    };

    const parseCurrent = (pre) =>
      Array.from(pre.querySelectorAll('.log-line')).map((el) => ({
        level: el.className.replace('log-line ', ''),
        text: el.textContent,
      }));

    // 选择器变化
    if (select) {
      select.addEventListener('change', () => {
        if (select.value && select.value !== currentName) connect(select.value);
      });
    }

    filterEl.addEventListener('input', () => {
      if (filterEl.value.trim()) {
        render(parseCurrent(preEl));
      } else {
        render(parseCurrent(preEl));
      }
    });

    btnCopy.addEventListener('click', () => {
      navigator.clipboard.writeText(lastText).then(
        () => mdui.snackbar({ message: '日志已复制到剪贴板' }),
        () => mdui.snackbar({ message: '复制失败' })
      );
    });

    btnClear.addEventListener('click', () => {
      preEl.innerHTML = '';
      lastText = '';
      updateStatus('已清屏');
    });

    autoEl.addEventListener('change', () => {
      if (autoEl.checked) preEl.scrollTop = preEl.scrollHeight;
    });

    // 初始连接：优先用 select 中的值
    const initial = select && select.value ? select.value : buildUrl('').split('?')[0].split('/').pop();
    connect(initial);

    // 定期保活/重连兜底
    timer = setInterval(() => {
      if (!live && (!source || source.readyState === EventSource.CLOSED)) {
        connect(currentName);
      }
    }, 5000);
    window.addEventListener('beforeunload', () => {
      if (source) source.close();
      clearInterval(timer);
    });
  }

  function initLogs() {
    connectLogStream({
      kind: 'prpll',
      select: $('#prpllLogSelect'),
      filterEl: $('#prpllFilter'),
      autoEl: $('#prpllAutoScroll'),
      preEl: $('#prpllLog'),
      statusEl: $('#prpllLogStatus'),
      btnCopy: $('#prpllCopyBtn'),
      btnClear: $('#prpllClearBtn'),
      buildUrl: (name) => `/api/log-stream/${name || 'gpuowl-0.log'}?lines=${LOG_LINES}`,
    });

    connectLogStream({
      kind: 'apn',
      select: null,
      filterEl: $('#apnFilter'),
      autoEl: $('#apnAutoScroll'),
      preEl: $('#apnLog'),
      statusEl: $('#apnLogStatus'),
      btnCopy: $('#apnCopyBtn'),
      btnClear: $('#apnClearBtn'),
      buildUrl: () => `/api/log-stream/autoprimenet.log?lines=${LOG_LINES}`,
    });
  }

  // ---------------------------------------------------------------- 启动
  function init() {
    initTheme();
    initClock();
    initLogs();
    initMersenne();
    initTasks();
    loadStatus();
    setInterval(() => loadStatus(false), POLL_MS);

    // 窗口大小变化时重绘图表
    const redraw = () => {
      if (statusData) drawCharts(statusData.prpll);
    };
    window.addEventListener('resize', redraw);
    if (window.ResizeObserver) {
      const obs = new ResizeObserver(() => redraw());
      document.querySelectorAll('.chart').forEach((c) => obs.observe(c));
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
