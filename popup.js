/**
 * Popup 逻辑：显示同步状态，提供手动同步按钮
 */

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleString();
}

function fmtDuration(start, end) {
  if (!start || !end) return '';
  const secs = Math.round((end - start) / 1000);
  if (secs < 1) return '不到 1 秒';
  if (secs < 60) return secs + ' 秒';
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return m + ' 分 ' + s + ' 秒';
}

function fmtStats(stats) {
  if (!stats) return '';
  const parts = [];
  const labels = [
    ['created', '新增'],
    ['updated', '更新'],
    ['renamed', '改名'],
    ['moved', '调整顺序'],
    ['deleted', '删除'],
    ['added', '远端新增'],
    ['removed', '墓碑忽略'],
    ['deduped', '去重'],
  ];
  for (const [k, label] of labels) {
    const v = stats[k];
    if (v && v > 0) parts.push(`${label} ${v}`);
  }
  if (parts.length === 0) return '无变化';
  return parts.join('，');
}

function renderStatus(status, db) {
  const cfgBadge = document.getElementById('cfgBadge');
  const engineBadge = document.getElementById('engineBadge');
  const statusEl = document.getElementById('status');
  const statsEl = document.getElementById('stats');
  const lastSyncEl = document.getElementById('lastSync');

  const st = status || { state: 'idle' };
  const now = Date.now();

  switch (st.state) {
    case 'syncing':
      engineBadge.textContent = '同步中…';
      engineBadge.className = 'badge syncing';
      statusEl.innerHTML = '<span class="spinner"></span>正在同步（' + (st.reason || '') + '）…';
      statusEl.className = '';
      statsEl.textContent = '';
      break;
    case 'done':
      engineBadge.textContent = '完成 ✓';
      engineBadge.className = 'badge done';
      if (st.error) {
        statusEl.textContent = '完成（但显示过错误：' + st.error + '）';
        statusEl.className = 'err';
      } else {
        statusEl.textContent = '同步完成 ✓ ' + (st.endAt ? '耗时 ' + fmtDuration(st.startAt, st.endAt) : '');
        statusEl.className = 'ok';
      }
      statsEl.textContent = '本次：' + fmtStats(st.stats);
      break;
    case 'error':
      engineBadge.textContent = '出错';
      engineBadge.className = 'badge off';
      statusEl.textContent = '同步失败：' + (st.error || '未知错误');
      statusEl.className = 'err';
      statsEl.textContent = '';
      break;
    case 'skipped':
      engineBadge.textContent = '空闲';
      engineBadge.className = 'badge off';
      statusEl.textContent = '上次同步还在进行中，本次已跳过';
      statusEl.className = '';
      statsEl.textContent = '';
      break;
    default: // idle
      if (db && db.lastError && !st.done) {
        engineBadge.textContent = '出错';
        engineBadge.className = 'badge off';
        statusEl.textContent = '最近错误：' + db.lastError;
        statusEl.className = 'err';
        statsEl.textContent = '';
      } else if (st.pendingChanges > 0) {
        engineBadge.textContent = '待同步';
        engineBadge.className = 'badge warn';
        statusEl.textContent = '检测到书签变化，' + st.pendingChanges + ' 处待同步…';
        statusEl.className = '';
        statsEl.textContent = '';
      } else if (db && db.lastSyncAt) {
        engineBadge.textContent = '空闲';
        engineBadge.className = 'badge off';
        statusEl.textContent = '上次同步：' + fmtTime(db.lastSyncAt);
        statusEl.className = '';
        statsEl.textContent = db.lastStats ? '上次：' + fmtStats(db.lastStats) : '';
      } else {
        engineBadge.textContent = '空闲';
        engineBadge.className = 'badge off';
        statusEl.textContent = '尚未同步';
        statusEl.className = '';
        statsEl.textContent = '';
      }
  }

  // 底部信息
  if (db && db.lastSyncAt) {
    const cfg = db.lastSyncBy ? '实例：' + db.lastSyncBy : '';
    lastSyncEl.textContent = cfg;
  } else {
    lastSyncEl.textContent = '';
  }
}

async function refresh() {
  const resp = await chrome.runtime.sendMessage({ type: 'get_status' }).catch(() => null);
  const db = resp && resp.db;
  const status = resp && resp.status;

  // 配置状态
  const data = await chrome.storage.local.get('config');
  const hasCfg = !!(data.config && data.config.username && data.config.appPassword);
  const cfgBadge = document.getElementById('cfgBadge');
  cfgBadge.textContent = hasCfg ? '已配置' : '未配置';
  cfgBadge.className = 'badge ' + (hasCfg ? 'on' : 'off');

  renderStatus(status, db);
}

document.getElementById('syncBtn').addEventListener('click', async () => {
  const btn = document.getElementById('syncBtn');
  btn.disabled = true;
  btn.textContent = '同步中…';
  try {
    const result = await chrome.runtime.sendMessage({ type: 'sync_now' });
    const statusEl = document.getElementById('status');
    if (result && result.ok) {
      statusEl.textContent = '同步完成 ✓';
      statusEl.className = 'ok';
      document.getElementById('stats').textContent = '本次：' + fmtStats(result.stats);
    } else if (result && result.error) {
      statusEl.textContent = '同步失败：' + result.error;
      statusEl.className = 'err';
    } else if (result && result.skipped) {
      statusEl.textContent = '已有同步在进行中，本次已跳过';
      statusEl.className = '';
    }
  } catch (e) {
    document.getElementById('status').textContent = '同步失败：' + e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = '立即同步';
    refresh();
  }
});

document.getElementById('openOptions').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

document.getElementById('diagBtn').addEventListener('click', async () => {
  const diagEl = document.getElementById('diag');
  diagEl.style.display = 'block';
  diagEl.textContent = '诊断中…';
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'diagnose' });
    if (resp === undefined) {
      diagEl.textContent = '诊断失败：后台无响应（sendMessage 超时）。请尝试重新加载扩展。';
      return;
    }
    if (!resp || !resp.ok) {
      diagEl.textContent = '诊断失败：' + (resp && resp.error ? resp.error : '未知错误（resp=' + JSON.stringify(resp) + '）');
      return;
    }
    const lines = [];
    lines.push('【配置】');
    lines.push('已配置: ' + (resp.config.configured ? '是' : '否'));
    if (resp.config.username) lines.push('账号: ' + resp.config.username);
    lines.push('同步目录: ' + resp.config.folder);
    lines.push('同步间隔: ' + resp.config.intervalMin + ' 分钟');
    lines.push('');
    lines.push('【本机书签】');
    lines.push('总节点数: ' + resp.local.nodes);
    lines.push('顶层: ' + resp.local.topLevel.join(' | '));
    lines.push('');
    lines.push('【云端数据】');
    if (resp.cloud && resp.cloud.exists) {
      lines.push('文件存在 ✓');
      lines.push('节点数: ' + resp.cloud.nodes);
      lines.push('版本: v' + resp.cloud.version);
      lines.push('上次写入实例: ' + resp.cloud.instance);
      lines.push('上次更新时间: ' + (resp.cloud.updatedAt ? new Date(resp.cloud.updatedAt).toLocaleString() : '未知'));
      lines.push('墓碑数: ' + resp.cloud.tombstones);
    } else if (resp.cloud) {
      lines.push(resp.cloud.error ? ('读取失败: ' + resp.cloud.error) : '文件不存在（还没同步过）');
      lines.push('目录: ' + resp.cloud.folder);
    } else {
      lines.push('未配置无法读取');
    }
    lines.push('');
    lines.push('【本地同步状态】');
    lines.push('上次同步: ' + (resp.db.lastSyncAt ? new Date(resp.db.lastSyncAt).toLocaleString() : '从未'));
    lines.push('上次实例: ' + (resp.db.lastSyncBy || '-'));
    lines.push('本地墓碑: ' + resp.db.tombstoneCount + ' 条');
    if (resp.db.trace && resp.db.trace.length) {
      lines.push('');
      lines.push('【最近同步日志】');
      lines.push(resp.db.trace.join('\n'));
    }
    diagEl.textContent = lines.join('\n');
  } catch (e) {
    diagEl.textContent = '诊断失败：' + e.message;
  }
});

document.getElementById('resetTbBtn').addEventListener('click', async () => {
  const btn = document.getElementById('resetTbBtn');
  if (!confirm('确定清空本机的同步墓碑记录吗？\n\n这用于修复历史错误墓碑积累导致的书签被误删。\n会清空本机墓碑和同步基准，下次同步以当前浏览器书签为准重建。\n\n不影响你的书签数据本身。')) return;
  btn.disabled = true;
  btn.textContent = '重置中…';
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'reset_tombstones' });
    const statusEl = document.getElementById('status');
    if (resp && resp.ok) {
      statusEl.textContent = '已清空 ' + resp.cleared + ' 条墓碑，请点「立即同步」重建';
      statusEl.className = 'ok';
    } else {
      statusEl.textContent = '重置失败：' + ((resp && resp.error) || '未知错误');
      statusEl.className = 'err';
    }
  } catch (e) {
    document.getElementById('status').textContent = '重置失败：' + e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = '重置墓碑（修复）';
    refresh();
  }
});

refresh();
// 打开 popup 期间轮询刷新（同步中能看到进度变化）
setInterval(() => {
  if (!document.hidden) refresh();
}, 2000);
