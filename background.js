/**
 * Background Service Worker - 同步引擎
 *
 * 职责：
 *   - 全自动同步：定时（alarm）+ 书签变化（onChanged/onCreated/onMoved/onRemoved）触发
 *   - 维护「最后已知树」与「墓碑」实现冲突合并 + 删除传播
 *   - WebDAV 读写、去重、双向合并、应用回浏览器
 *   - 防抖：书签连续变化时延迟同步，避免频繁请求
 */

importScripts('webdav.js', 'merge.js');

// 解构引用（全局命名空间，由 importScripts 提供）
const {
  readRemoteFile,
  writeRemoteFile,
} = self.JianguoyunDAV;
const {
  serializeTree,
  mergeTrees,
  dedupeTree,
  applyTreeToBrowser,
  bookmarkFingerprint,
  DUP_FOLDER_NAME,
} = self.BookmarkMerge;

// ---------- 常量 ----------

const SYNC_INTERVAL_MIN_DEFAULT = 15; // 默认每 15 分钟同步
const DEBOUNCE_MS = 5000;              // 书签变化后防抖 5 秒
const LOCK_TTL_MS = 2 * 60 * 1000;     // 锁 2 分钟过期
const DB_KEY = 'bookmarks_sync_db';    // chrome.storage.local 键

// ---------- 同步日志 ----------

let syncTrace = []; // 本次同步的过程日志（节点数、步骤）

function traceLog(msg) {
  const t = new Date().toLocaleTimeString();
  syncTrace.push(t + ' ' + msg);
  console.log('[sync]', msg);
}

function countNodes(tree) {
  let c = 0;
  const w = (ns) => (ns || []).forEach(n => { c++; if (n.children) w(n.children); });
  w(tree);
  return c;
}

// ---------- 状态 ----------

let syncRunning = false;
let debounceTimer = null;
let dirty = false;
let applying = false; // 正在应用合并结果到浏览器（抑制事件触发的回流）
let syncStatus = {   // 实时同步状态（popup 读取）
  state: 'idle',     // idle | syncing | done | error | skipped
  startAt: 0,
  endAt: 0,
  reason: '',
  stats: null,       // 本次同步统计
  error: null,
  pendingChanges: 0, // 待同步的书签变化数（防抖期间累计）
};

/** 更新同步状态 + 工具栏角标 */
async function setSyncStatus(patch) {
  syncStatus = { ...syncStatus, ...patch };
  // 更新工具栏角标
  try {
    const title = syncTitle();
    if (syncStatus.state === 'syncing') {
      await chrome.action.setBadgeText({ text: '同步' });
      await chrome.action.setBadgeBackgroundColor({ color: '#4f83cc' });
    } else if (syncStatus.state === 'error') {
      await chrome.action.setBadgeText({ text: '!' });
      await chrome.action.setBadgeBackgroundColor({ color: '#dc2626' });
    } else if (syncStatus.state === 'done') {
      await chrome.action.setBadgeText({ text: '✓' });
      await chrome.action.setBadgeBackgroundColor({ color: '#16a34a' });
    } else if (syncStatus.state === 'idle' && syncStatus.pendingChanges > 0) {
      await chrome.action.setBadgeText({ text: '待' });
      await chrome.action.setBadgeBackgroundColor({ color: '#d97706' });
    } else {
      await chrome.action.setBadgeText({ text: '' });
    }
    await chrome.action.setTitle({ title });
  } catch (e) {
    // 角标失败不影响同步主流程
  }
}

function syncTitle() {
  const map = {
    idle: '书签坚果云同步（空闲）',
    syncing: '书签坚果云同步（同步中…）',
    done: '书签坚果云同步（完成 ✓）',
    error: '书签坚果云同步（出错）',
    skipped: '书签坚果云同步（已跳过）',
  };
  return map[syncStatus.state] || '书签坚果云同步';
}

// ---------- 存储 ----------

/**
 * 加载同步数据库（最后已知树 + 墓碑 + 元信息）
 */
async function loadDB() {
  const data = await chrome.storage.local.get(DB_KEY);
  const db = data[DB_KEY] || {};
  return {
    lastTree: db.lastTree || [],        // 上次成功同步时的本地树
    tombstones: db.tombstones || {},    // { 指纹/path: 删除时间戳 }
    lastSyncAt: db.lastSyncAt || 0,     // 上次成功同步时间
    lastSyncBy: db.lastSyncBy || null,  // 上次同步的实例 id
    lastError: db.lastError || null,
    lastStats: db.lastStats || null,    // 上次成功同步的统计
    lastTrace: db.lastTrace || [],      // 上次同步的过程日志
    retryCount: db.retryCount || 0,     // 412 冲突重试计数
    instanceId: db.instanceId || null,
    etag: db.etag || null,              // 远端文件 etag（并发控制）
  };
}

async function saveDB(db) {
  await chrome.storage.local.set({ [DB_KEY]: db });
}

// ---------- 配置 ----------

async function getConfig() {
  const data = await chrome.storage.local.get('config');
  return data.config || null;
}

// ---------- 触发同步 ----------

/** 防抖触发同步 */
function scheduleSync(reason) {
  dirty = true;
  syncStatus.pendingChanges++;
  setSyncStatus({}); // 刷新角标（如果有待同步变化）
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    runSync(reason).catch((e) => console.error('sync failed:', e));
  }, DEBOUNCE_MS);
}

// ---------- 主同步流程 ----------

/**
 * 执行一次完整同步
 */
async function runSync(reason = 'manual') {
  if (syncRunning) {
    await setSyncStatus({ state: 'skipped', error: null });
    return { skipped: true, reason: 'already_running' };
  }
  syncRunning = true;
  const started = Date.now();
  syncTrace = []; // 重置本次同步日志
  await setSyncStatus({ state: 'syncing', startAt: started, reason, error: null, stats: null });
  try {
    const config = await getConfig();
    if (!config) {
      await saveDB(await updateError(await loadDB(), '未配置 WebDAV，请在扩展设置页填写坚果云账号'));
      await setSyncStatus({ state: 'error', endAt: Date.now(), error: 'not_configured' });
      return { ok: false, error: 'not_configured' };
    }

    const db = await loadDB();

    // 1. 读取当前浏览器书签树
    //    getTree() 返回 [根节点]，根节点的 children 才是书签栏/其他书签/移动设备书签
    const tree = await chrome.bookmarks.getTree();
    const localTree = serializeTree(tree[0].children || []);
    traceLog('本地树节点: ' + countNodes(localTree) + '，顶层: ' + localTree.map(n => n.title).join(' | '));

    // 2. 读取远端书签文件
    const remoteResult = await readRemoteFile({
      username: config.username,
      appPassword: config.appPassword,
      folder: config.folder,
    });

    let remoteTree = null;
    let remoteEtag = null;
    let remoteTombstones = {}; // 其他设备写下的墓碑
    let remoteVersion = 0;     // 远端数据版本（写前重读时对比）

    if (remoteResult.ok) {
      remoteTree = remoteResult.data.tree || [];
      remoteTombstones = remoteResult.data._tombstones || {};
      remoteVersion = remoteResult.data._version || 0;
      // 使用 GET 响应头里的新鲜 etag（已由 webdav.js 规范化去引号）
      remoteEtag = remoteResult.etag || null;
      traceLog('远端树节点: ' + countNodes(remoteTree) + '，版本 v' + remoteVersion + '，墓碑 ' + Object.keys(remoteTombstones).length + ' 条');
    } else if (remoteResult.status === 404) {
      traceLog('远端不存在（首次同步）');
    } else {
      traceLog('远端读取失败: HTTP ' + remoteResult.status);
    }

    // 2.5 合并墓碑表：本地 + 远端（远端优先，因为那是「其他设备已知道的删除」）
    // 关键：让 A 删掉的书签在 B 上也不复活
    const tombstoneMap = new Map(Object.entries(remoteTombstones));
    for (const [k, v] of Object.entries(db.tombstones || {})) {
      if (!tombstoneMap.has(k) || tombstoneMap.get(k) < v) {
        tombstoneMap.set(k, v);
      }
    }

    // 2.6 收集「本地删除」：对比上次同步的 lastTree 和本次的 localTree。
    //     在合并之前做，这样 A 在浏览器里删掉的书签会被记入墓碑。
    const newTombstones = collectTombstones(db.lastTree, localTree, tombstoneMap);

    // 3. 合并
    let mergedTree = localTree;
    let stats = { added: 0, removed: 0, updated: 0, deduped: 0, created: 0, deleted: 0, renamed: 0, moved: 0, skippedDup: 0 };

    if (remoteTree) {
      // 双向合并（墓碑会阻止被删书签复活）
      const mergeResult = mergeTrees(localTree, remoteTree, newTombstones);
      mergedTree = mergeResult.tree;
      stats = { ...stats, ...mergeResult.stats };
      traceLog('合并后节点: ' + countNodes(mergedTree) + '，合并统计: ' + JSON.stringify(mergeResult.stats));
    } else {
      // 远端不存在：首次同步，直接上传本地树
      const { tree: deduped, moved } = dedupeTree(localTree);
      mergedTree = deduped;
      stats.deduped = moved.length;
      traceLog('首次同步上传本地树，去重 ' + moved.length + ' 个');
    }

    // 4. 应用合并结果到浏览器
    // 记录合并树顶层结构（用于诊断为什么应用创建 0 个）
    try {
      const topInfo = mergedTree.map(n => n.title + '[' + (n.children ? n.children.length : 0) + ']').join(' | ');
      traceLog('合并树顶层: ' + topInfo);
      const firstFolder = mergedTree.find(n => !n.url && n.children && n.children.length);
      if (firstFolder) {
        traceLog('合并树第一个文件夹 [' + firstFolder.title + '] 前5个子项: ' + firstFolder.children.slice(0, 5).map(c => (c.url ? '书签:' : '夹:') + c.title).join(', '));
      }
    } catch (e) {}

    applying = true;
    try {
      const applyStats = await applyTreeToBrowser(mergedTree);
      stats = { ...stats, ...applyStats };
      traceLog('应用回浏览器: 新增 ' + applyStats.created + '，删除 ' + applyStats.deleted + '，改名 ' + applyStats.renamed + '，移动 ' + applyStats.moved);
      // 追加 applyTreeToBrowser 内部日志
      const applyTrace = (self.BookmarkMerge._applyTrace || []).slice(-50);
      for (const line of applyTrace) traceLog('  ' + line);
    } finally {
      // 稍等片刻再关掉抑制，避免最后几个事件误触发
      setTimeout(() => { applying = false; }, 2000);
    }

    // 5. 再次读取应用后的树（最终一致）
    const finalTree = serializeTree((await chrome.bookmarks.getTree())[0].children || []);
    traceLog('应用后本地树节点: ' + countNodes(finalTree) + '，顶层: ' + finalTree.map(n => n.title).join(' | '));
    let finalDeduped = dedupeTree(finalTree).tree;

    // 5.5 安全护栏：如果应用环节没有成功创建书签（created 大量为 0），
    //     说明 applyTreeToBrowser 有 bug 或浏览器 API 失败。
    //     此时绝不能把缩水后的树上传覆盖云端。改用合并树本身作为上传数据。
    const mergedCount = countNodes(mergedTree);
    const finalCount = countNodes(finalDeduped);
    if (stats.created === 0 && mergedCount > finalCount + 5) {
      traceLog('⚠ 应用失败保护：合并树 ' + mergedCount + ' 节点，应用后仅 ' + finalCount + ' 节点，created=0。' +
        '改用合并树作为上传数据，避免覆盖云端。');
      // 用合并树代替（不含浏览器本地独有内容，但至少保住远端数据）
      finalDeduped = JSON.parse(JSON.stringify(mergedTree));
    }

    // 6. 写回远端（版本号 + 写前重读做并发控制）
    //    不依赖 If-Match（坚果云支持不可靠），改用 _version 对比。
    const writeCfg = { username: config.username, appPassword: config.appPassword, folder: config.folder };

    // 尝试写入；如果写前发现远端版本变了，重新合并再写（最多 3 次）
    let writeOk = false;
    let writeResult = null;
    let attempt = 0;
    let writtenInstance = null;

    while (!writeOk && attempt < 3) {
      attempt++;
      // 写前重读：确认远端在合并期间没有被其他设备改过
      const preWrite = await readRemoteFile(writeCfg);
      let preVersion = 0;
      let preTree = null;
      let preTomb = {};
      if (preWrite.ok) {
        preVersion = preWrite.data._version || 0;
        preTree = preWrite.data.tree || [];
        preTomb = preWrite.data._tombstones || {};
      }

      if (preWrite.ok && preVersion > remoteVersion) {
        // 远端在我们合并期间被改了：用最新远端重新合并
        const tomb2 = new Map(Object.entries(preTomb));
        for (const [k, v] of Object.entries(db.tombstones || {})) {
          if (!tomb2.has(k) || tomb2.get(k) < v) tomb2.set(k, v);
        }
        const merged2 = mergeTrees(localTree, preTree, tomb2);
        mergedTree = merged2.tree;
        // 重新应用合并结果
        applying = true;
        try {
          const applyStats = await applyTreeToBrowser(mergedTree);
          stats = { ...stats, ...applyStats };
        } finally {
          setTimeout(() => { applying = false; }, 2000);
        }
        // 更新最终树
        const reFinal = serializeTree((await chrome.bookmarks.getTree())[0].children || []);
        finalDeduped = dedupeTree(reFinal).tree;
        remoteVersion = preVersion;
        remoteTree = preTree;
        remoteTombstones = preTomb;
      }

      // 构造 payload 写入
      const payload = {
        tree: finalDeduped,
        _tombstones: Object.fromEntries(newTombstones),
        _version: remoteVersion + 1, // 版本递增
        _instance: db.instanceId || (await newInstanceId()),
        _updatedAt: Date.now(),
        _schema: 2,
      };
      writtenInstance = payload._instance;
      writeResult = await writeRemoteFile(writeCfg, payload);
      if (writeResult.ok) {
        writeOk = true;
        traceLog('上传成功: ' + countNodes(payload.tree) + ' 节点，版本 v' + payload._version);
        break;
      }
      // 写入失败（非 412，可能网络问题），记录错误退出
      await setSyncStatus({ state: 'error', endAt: Date.now(), error: '写入失败 HTTP ' + writeResult.status });
      return { ok: false, error: 'write_failed_' + writeResult.status };
    }

    if (!writeOk) {
      await setSyncStatus({ state: 'error', endAt: Date.now(), error: '并发冲突，重试超过 3 次，请检查多台电脑是否同时同步' });
      return { ok: false, error: 'conflict_exhausted' };
    }

    // 8. 更新本地数据库
    db.lastTree = finalDeduped;
    db.tombstones = Object.fromEntries(newTombstones); // chrome.storage 用 JSON，需转普通对象
    db.lastSyncAt = Date.now();
    db.lastSyncBy = writtenInstance;
    db.etag = writeResult.etag || remoteEtag || null;
    db.lastError = null;
    db.lastStats = stats; // 上次成功同步的统计
    db.retryCount = 0;    // 重置重试计数
    db.lastTrace = syncTrace.slice(-30); // 保存最近 30 条日志
    await saveDB(db);

    await setSyncStatus({
      state: 'done',
      endAt: Date.now(),
      stats,
      error: null,
      pendingChanges: 0,
    });
    return { ok: true, stats, reason };
  } catch (e) {
    const db = await loadDB();
    db.lastError = e.message;
    await saveDB(db);
    await setSyncStatus({ state: 'error', endAt: Date.now(), error: e.message });
    return { ok: false, error: e.message };
  } finally {
    syncRunning = false;
    dirty = false;
  }
}

// ---------- 墓碑收集 ----------

/**
 * 对比旧树和新树，找出「在旧树中存在、新树中不存在」的删除。
 * 返回 Map<指纹或路径, 删除时间戳>。
 * 入参 existing 可以是 Map 或普通对象，统一转成 Map。
 */
function collectTombstones(oldTree, newTree, existing) {
  const tombstones = existing instanceof Map
    ? new Map(existing)
    : new Map(Object.entries(existing || {}));
  const now = Date.now();

  const newFps = new Set();
  const newPaths = new Set();

  const walkNew = (nodes, path) => {
    for (const n of nodes) {
      if (n.url) {
        const fp = bookmarkFingerprint(n.url);
        if (fp) newFps.add(fp);
      } else {
        const p = path + '/' + (n.title || '');
        newPaths.add(p);
        if (n.children) walkNew(n.children, p);
      }
    }
  };
  walkNew(newTree, '');

  const walkOld = (nodes, path) => {
    for (const n of nodes) {
      if (n.url) {
        const fp = bookmarkFingerprint(n.url);
        if (fp && !newFps.has(fp)) {
          tombstones.set(fp, now);
        }
      } else {
        const p = path + '/' + (n.title || '');
        // 归一化根文件夹名，跨浏览器一致（收藏夹栏/书签栏 -> bar）
        const normP = self.BookmarkMerge.normalizeRootPath(p);
        if (!newPaths.has(p) && !newPaths.has(normP)) {
          tombstones.set(normP, now);
        }
        if (n.children) walkOld(n.children, p);
      }
    }
  };
  walkOld(oldTree, '');

  // 清理超过 30 天的墓碑
  const cutoff = now - 30 * 24 * 3600 * 1000;
  for (const [k, v] of tombstones) {
    if (v < cutoff) tombstones.delete(k);
  }

  return tombstones; // Map
}

// ---------- 实例 ID ----------

async function newInstanceId() {
  const id = 'inst_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  const db = await loadDB();
  db.instanceId = id;
  await saveDB(db);
  return id;
}

async function updateError(db, msg) {
  db.lastError = msg;
  return db;
}

// ---------- 书签事件监听 ----------
// 注意：applyTreeToBrowser 会触发这些事件，用 applying 标志抑制回流

function onChange(reason) {
  if (applying) return;
  scheduleSync(reason);
}

chrome.bookmarks.onCreated.addListener(() => onChange('created'));
chrome.bookmarks.onRemoved.addListener(() => onChange('removed'));
chrome.bookmarks.onChanged.addListener(() => onChange('changed'));
chrome.bookmarks.onMoved.addListener(() => onChange('moved'));
chrome.bookmarks.onChildrenReordered.addListener(() => onChange('reordered'));
chrome.bookmarks.onImportBegan.addListener(() => onChange('import_began'));
chrome.bookmarks.onImportEnded.addListener(() => onChange('import_ended'));

// ---------- Alarm ----------

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'bookmark-sync') {
    runSync('alarm').catch((e) => console.error(e));
  }
});

// 启动时设置定时
chrome.runtime.onInstalled.addListener(async () => {
  const config = await getConfig();
  const interval = (config && config.intervalMin) || SYNC_INTERVAL_MIN_DEFAULT;
  await chrome.alarms.create('bookmark-sync', { periodInMinutes: interval });
  // 安装后延迟 30 秒做首次同步
  setTimeout(() => runSync('install').catch(() => {}), 30000);
});

// 浏览器启动 / service worker 唤醒时，确保 alarm 存在
chrome.runtime.onStartup.addListener(async () => {
  const config = await getConfig();
  const interval = (config && config.intervalMin) || SYNC_INTERVAL_MIN_DEFAULT;
  await chrome.alarms.create('bookmark-sync', { periodInMinutes: interval });
});

// 消息处理（popup / options 调用）
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'sync_now') {
    runSync('manual').then((result) => sendResponse(result));
    return true; // 异步响应
  }
  if (msg.type === 'get_status') {
    loadDB().then((db) => sendResponse({ db, status: syncStatus }));
    return true;
  }
  if (msg.type === 'diagnose') {
    // 诊断：对比云端数据、本地书签、配置
    (async () => {
      try {
        const config = await getConfig();
        const db = await loadDB();
        const tree = await chrome.bookmarks.getTree();
        const localTree = serializeTree(tree[0].children || []);

        let cloudInfo = null;
        if (config && config.username && config.appPassword) {
          const r = await readRemoteFile({
            username: config.username,
            appPassword: config.appPassword,
            folder: config.folder,
          });
          if (r.ok) {
            const countNodes = (nodes) => {
              let c = 0;
              const w = (ns) => ns.forEach(n => { c++; if (n.children) w(n.children); });
              w(nodes);
              return c;
            };
            cloudInfo = {
              exists: true,
              nodes: countNodes(r.data.tree || []),
              version: r.data._version || 0,
              instance: r.data._instance || null,
              updatedAt: r.data._updatedAt || 0,
              folder: config.folder || '(默认 Bookmarks)',
              tombstones: Object.keys(r.data._tombstones || {}).length,
            };
          } else if (r.status === 404) {
            cloudInfo = { exists: false, folder: config.folder || '(默认 Bookmarks)' };
          } else {
            cloudInfo = { exists: false, error: 'HTTP ' + r.status };
          }
        }

        const countLocal = (nodes) => {
          let c = 0;
          const w = (ns) => ns.forEach(n => { c++; if (n.children) w(n.children); });
          w(nodes);
          return c;
        };

        sendResponse({
          ok: true,
          config: {
            configured: !!(config && config.username && config.appPassword),
            username: config ? config.username : null,
            folder: config ? (config.folder || '(默认 Bookmarks)') : null,
            intervalMin: config ? config.intervalMin : null,
          },
          local: {
            nodes: countLocal(localTree),
            topLevel: localTree.map(n => n.title + (n.children ? '[' + n.children.length + ']' : '')),
          },
          cloud: cloudInfo,
          db: {
            lastSyncAt: db.lastSyncAt,
            lastSyncBy: db.lastSyncBy,
            lastStats: db.lastStats,
            tombstoneCount: Object.keys(db.tombstones || {}).length,
            trace: db.lastTrace || [],
          },
        });
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true;
  }
  if (msg.type === 'reconfigured') {
    // 配置变化：更新 alarm
    chrome.alarms.create('bookmark-sync', { periodInMinutes: msg.intervalMin || SYNC_INTERVAL_MIN_DEFAULT });
    // 延迟 3 秒后同步（让配置先保存完）
    setTimeout(() => runSync('reconfigured').catch(() => {}), 3000);
    sendResponse({ ok: true });
    return false;
  }
  if (msg.type === 'update_config') {
    chrome.storage.local.set({ config: msg.config }).then(() => {
      sendResponse({ ok: true });
    });
    return true;
  }
  if (msg.type === 'test_connection') {
    // 测试 WebDAV 连接
    (async () => {
      try {
        const result = await readRemoteFile({
          username: msg.username,
          appPassword: msg.appPassword,
          folder: msg.folder,
        });
        if (result.ok || result.status === 404) {
          sendResponse({ ok: true });
        } else {
          sendResponse({ ok: false, error: `HTTP ${result.status}` });
        }
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true; // 异步响应
  }
  if (msg.type === 'list_folders') {
    // 列出 WebDAV 目录（设置页目录浏览器）
    (async () => {
      try {
        const result = await self.JianguoyunDAV.listFolders(
          {
            username: msg.username,
            appPassword: msg.appPassword,
          },
          msg.path || ''
        );
        sendResponse(result);
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }
});

// 确保 alarm 在 worker 唤醒时存在
(async () => {
  try {
    const config = await getConfig();
    if (config) {
      const interval = config.intervalMin || SYNC_INTERVAL_MIN_DEFAULT;
      await chrome.alarms.create('bookmark-sync', { periodInMinutes: interval });
    }
  } catch (e) {
    // worker 刚唤醒时 storage 可能未就绪，忽略
  }
})();
