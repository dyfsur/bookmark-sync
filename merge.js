/**
 * 书签树数据模型 + 双向合并算法
 * (MV3 Service Worker 不能用 ES modules，这里暴露全局命名空间 window.BookmarkMerge)
 *
 * 设计目标：
 *   - 保留书签树的原始层级、顺序（不做垂直书签等任何改造）
 *   - 双向合并：两边各自的改动都保留
 *   - 去重：URL 指纹相同视为同一书签，自动折叠
 *   - 删除墓碑：一边删掉的书签，另一边不会再复活（30 天内）
 */

(function () {
  'use strict';

  const BM = {};

  // Chrome/Edge 永久节点 ID（根 0 / 书签栏 1 / 其他书签 2 / 移动设备书签 3）
  // 这些节点不允许被创建、删除、改名或移动
  const SPECIAL_ROOT_IDS = { '1': 'bar', '2': 'other', '3': 'mobile' };

  // 根文件夹的本地化别名（不同语言/不同浏览器命名不同）
  // 归一化 key：bar/other/mobile
  const ROOT_ALIASES = {
    'bar': ['书签栏', '收藏夹栏', 'Bookmarks Bar', 'Bokmerkelinjen', 'Boomarkenleiste', 'bar'],
    'other': ['其他书签', '其他收藏夹', 'Other Bookmarks', 'Andre bokmerker', 'Weitere Lesezeichen', 'other'],
    'mobile': ['移动设备书签', '移动收藏夹', 'Mobile Bookmarks', 'Mobil bokmerker', 'Mobiles Lesezeichen', 'mobile'],
  };

  /** 判断标题是否是某个根文件夹的别名，返回归一化 key 或 null */
  BM.rootKeyOf = function (title) {
    if (!title) return null;
    const t = String(title).trim();
    for (const [key, aliases] of Object.entries(ROOT_ALIASES)) {
      if (aliases.includes(t)) return key;
    }
    return null;
  };

  /** 获取本浏览器实际使用的根文件夹标题（由 getTree 决定的默认名） */
  BM.rootTitleFor = function (key, fallback) {
    // 浏览器里已经存在的根文件夹优先，fallback 兜底
    return fallback || key;
  };

  /**
   * 规范化路径中的根文件夹名（本地化别名 -> 归一化 key）。
   * 例如 '/收藏夹栏/A' -> '/bar/A'，这样跨浏览器墓碑路径一致。
   */
  BM.normalizeRootPath = function (path) {
    if (!path) return path || '';
    let p = String(path);
    const segments = p.split('/');
    // 只处理第一段（根文件夹名）
    if (segments.length > 1) {
      const first = segments[1];
      if (first) {
        const rk = BM.rootKeyOf(first);
        if (rk) segments[1] = rk;
      }
    }
    return segments.join('/');
  };

  // ---------- 工具 ----------

  /** 规范化 URL 作为去重指纹 */
  BM.normalizeUrl = function (url) {
    if (!url) return null;
    try {
      let u = url.trim();
      if (!u) return null;
      if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(u)) {
        u = 'https://' + u;
      }
      const parsed = new URL(u);
      parsed.hash = '';
      if ((parsed.protocol === 'http:' && parsed.port === '80') ||
          (parsed.protocol === 'https:' && parsed.port === '443')) {
        parsed.port = '';
      }
      let key = `${parsed.protocol}//${parsed.hostname}${parsed.port}${parsed.pathname}`;
      if (key.length > 1 && key.endsWith('/')) key = key.slice(0, -1);
      const params = Array.from(parsed.searchParams.entries()).sort((a, b) =>
        a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)
      );
      if (params.length) key += '?' + params.map(([k, v]) => `${k}=${v}`).join('&');
      return key;
    } catch (e) {
      return url.trim().toLowerCase();
    }
  };

  /** 简单字符串 hash（FNV-1a） */
  BM.fnv1a = function (str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
  };

  /** 书签指纹：规范化 URL -> 短 hash */
  BM.bookmarkFingerprint = function (url) {
    const norm = BM.normalizeUrl(url);
    if (!norm) return null;
    return BM.fnv1a(norm);
  };

  // ---------- 序列化 ----------

  BM.serializeTree = function (nodes) {
    const convert = (node) => {
      const out = { title: node.title || '' };
      if (node.url) out.url = node.url;
      if (node.dateAdded) out.created = node.dateAdded;
      if (node.dateGroupModified) out.modified = node.dateGroupModified;
      if (node.children && node.children.length) {
        out.children = node.children.map(convert);
      }
      return out;
    };
    return nodes.map(convert);
  };

  BM.buildIndex = function (tree, parentKey, keyMap, counter) {
    keyMap = keyMap || new Map();
    counter = counter || { n: 0 };
    for (const node of tree) {
      counter.n++;
      let key;
      if (node.url) {
        key = 'b:' + BM.bookmarkFingerprint(node.url);
      } else {
        const parentPath = parentKey ? (keyMap.get(parentKey)?.path || parentKey) : '';
        key = 'f:' + parentPath + '/' + (node.title || '');
      }
      let finalKey = key;
      let suffix = 2;
      while (keyMap.has(finalKey) && keyMap.get(finalKey) !== node) {
        finalKey = node.url ? `b:${BM.bookmarkFingerprint(node.url)}:${suffix}` : `${key}:${suffix}`;
        suffix++;
      }
      const entry = {
        key: finalKey,
        parentKey: parentKey || null,
        title: node.title || '',
        url: node.url || null,
        created: node.dateAdded || 0,
        modified: node.dateGroupModified || (node.url ? node.dateAdded || 0 : 0),
        children: [],
        path: node.url ? undefined : (keyMap.get(parentKey)?.path || '') + '/' + (node.title || ''),
      };
      keyMap.set(finalKey, entry);
      if (node.children) {
        for (const child of node.children) {
          const ck = BM.buildIndex([child], finalKey, keyMap, counter);
          entry.children.push(ck);
        }
      }
    }
    return keyMap;
  };

  BM.deserializeTree = function (node) {
    const out = { title: node.title || '' };
    if (node.url) out.url = node.url;
    if (node.created) out.dateAdded = node.created;
    if (node.modified) out.dateGroupModified = node.modified;
    if (node.children) {
      out.children = node.children.map(BM.deserializeTree);
    }
    return out;
  };

  // ---------- 去重 ----------

  BM.DUP_FOLDER_NAME = '重复书签';

  /**
   * 树内去重：URL 指纹重复的节点保留第一个，其余移入「重复书签」文件夹
   * @returns {{tree: Array, moved: Array}}
   */
  BM.dedupeTree = function (tree) {
    const seen = new Map();
    const moved = [];
    const dupFolder = { title: BM.DUP_FOLDER_NAME, children: [], created: Date.now() };

    const walk = (nodes) => {
      const keep = [];
      for (const node of nodes) {
        if (node.url) {
          const fp = BM.bookmarkFingerprint(node.url);
          if (seen.has(fp)) {
            dupFolder.children.push({ ...node });
            moved.push(node);
            continue;
          }
          seen.set(fp, true);
          keep.push(node);
        } else {
          if (node.children) {
            node.children = walk(node.children);
          }
          keep.push(node);
        }
      }
      return keep;
    };

    const result = walk(tree);
    if (dupFolder.children.length) {
      result.push(dupFolder);
    }
    return { tree: result, moved };
  };

  // ---------- 双向合并 ----------

  /**
   * 合并本地树与远端树。返回 { tree, stats }。
   * 策略：
   *   - 以远端树为基底（深拷贝），把本地差异合并进去
   *   - URL 指纹匹配书签；文件夹按「路径 + 标题」匹配
   *   - 两边都有：修改时间新的保留标题
   *   - 墓碑内节点（30 天内被删）不再复活
   *   - 合并后整体去重，重复书签移入「重复书签」文件夹
   */
  BM.mergeTrees = function (localTree, remoteTree, tombstones) {
    const stats = { added: 0, removed: 0, updated: 0, deduped: 0 };
    tombstones = tombstones || new Map();

    // 深拷贝远端树作为基底
    const clone = (node) => {
      const c = { ...node };
      if (c.children) c.children = c.children.map(clone);
      return c;
    };
    const base = remoteTree.map(clone);

    const tombstoned = (fp, path, nodeCreated) => {
      // 归一化路径中的根文件夹名，保证跨浏览器（收藏夹栏/书签栏）匹配
      const normPath = BM.normalizeRootPath(path);
      const t = tombstones.get(fp) || tombstones.get(normPath) || tombstones.get(path);
      if (!t) return false;
      // 墓碑过期（超过 30 天）不再拦截
      if (Date.now() - t >= 30 * 24 * 3600 * 1000) return false;
      // 关键判别：如果节点创建时间晚于墓碑时间，说明是「删除后重新新建」，放行
      if (nodeCreated && nodeCreated > t) return false;
      return true;
    };

    // 把一个本地节点合并进 baseNodes（同路径数组）
    // 墓碑是删除方写入的可信删除信号。本地节点同样受墓碑约束：
    //  - 若墓碑标记了它，说明其他设备已删除 → 本设备也应删除（删除传播）
    //  - 但若节点创建时间晚于墓碑时间（删除后重新新建）→ 放行
    const mergeNode = (localNode, baseNodes, path) => {
      if (localNode.url) {
        const fp = BM.bookmarkFingerprint(localNode.url);
        if (fp && tombstoned(fp, path, localNode.created)) {
          stats.removed++;
          return;
        }
        const existing = baseNodes.find((n) => n.url && BM.bookmarkFingerprint(n.url) === fp);
        if (existing) {
          const localMod = localNode.created || 0;
          const remoteMod = existing.created || 0;
          if (localMod > remoteMod && existing.title !== localNode.title) {
            existing.title = localNode.title;
            stats.updated++;
          }
          // 保留较新的创建时间
          if (localMod > remoteMod) {
            existing.created = localNode.created;
          }
        } else {
          baseNodes.push({ ...localNode });
          stats.added++;
        }
        return;
      }

      // 文件夹：按标题匹配（根文件夹考虑本地化别名）
      const fpath = path + '/' + (localNode.title || '');
      if (tombstoned('', fpath, localNode.created)) {
        stats.removed++;
        return;
      }
      const localRootKey = BM.rootKeyOf(localNode.title);
      let folder = baseNodes.find((n) => {
        if (!n.url) {
          // 若目标文件夹是根文件夹（有别名），用归一化 key 匹配
          if (localRootKey) {
            return BM.rootKeyOf(n.title) === localRootKey;
          }
          return n.title === localNode.title;
        }
        return false;
      });
      if (!folder) {
        folder = { title: localNode.title, children: [], created: Date.now() };
        baseNodes.push(folder);
        stats.added++;
      } else if (!folder.children) {
        folder.children = [];
      }
      // 保留较新的创建时间（用于墓碑区分「删除 vs 重新创建」）
      if (localNode.created && (!folder.created || localNode.created > folder.created)) {
        folder.created = localNode.created;
      }
      for (const child of localNode.children || []) {
        mergeNode(child, folder.children, fpath);
      }
    };

    for (const n of localTree) {
      mergeNode(n, base, '');
    }

    // 最终过滤：把墓碑标记的节点从合并结果里剔除（防御性）。
    // 墓碑是删除方写入的可信删除信号，基于「创建时间」区分删除 vs 重新创建：
    //  - 节点创建时间早于墓碑时间 → 旧节点，删除应生效（移除）
    //  - 节点创建时间晚于墓碑时间 → 用户删除后重新新建，放行
    const filterTree = (nodes, parentPath) => {
      parentPath = parentPath || '';
      const out = [];
      for (const n of nodes) {
        if (n.url) {
          const fp = BM.bookmarkFingerprint(n.url);
          if (fp && tombstoned(fp, '', n.created)) {
            stats.removed++;
            continue;
          }
          out.push(n);
        } else {
          const fpath = parentPath + '/' + (n.title || '');
          if (tombstoned('', fpath, n.created)) {
            stats.removed++;
            continue;
          }
          const copy = { ...n };
          if (n.children) copy.children = filterTree(n.children, fpath);
          out.push(copy);
        }
      }
      return out;
    };

    const filtered = filterTree(base, '');
    const { tree, moved } = BM.dedupeTree(filtered);
    stats.deduped = moved.length;
    return { tree, stats };
  };

  // ---------- 应用回浏览器 ----------

  // 忽略「修改根文件夹」错误的兜底保护：无论哪个代码路径误操作特殊根，
  // 都不让同步崩溃，而是跳过该操作并告警。
  const IGNORED_ROOT_ERROR = /root bookmark folders/i;
  const safeOp = async (fn) => {
    try {
      return await fn();
    } catch (e) {
      if (IGNORED_ROOT_ERROR.test((e && e.message) || '')) {
        console.warn('[sync] skipped operation on a special root folder:', e.message);
        return null;
      }
      throw e;
    }
  };

  BM.applyTreeToBrowser = async function (targetTree) {
    // 应用过程日志（background.js 会读取用于诊断）
    BM._applyTrace = [];
    const alog = (msg) => { BM._applyTrace.push(msg); };

    const rootTree = (await chrome.bookmarks.getTree())[0];
    const rootId = rootTree.id;
    const rootKids = rootTree.children || [];
    // 识别浏览器根文件夹：ID 优先，标题兜底（不同语言/版本命名不同）
    const browserRoots = {};   // bar/other/mobile -> 浏览器节点
    const rootIdSet = new Set(); // 被识别为根的所有 id（用于删除保护）
    for (const k of rootKids) {
      const rk = SPECIAL_ROOT_IDS[String(k.id)] || BM.rootKeyOf(k.title);
      if (rk) {
        if (!browserRoots[rk]) browserRoots[rk] = k;
        rootIdSet.add(String(k.id));
      }
    }
    alog('[browser roots] ' + Object.entries(browserRoots).map(([k, v]) => k + '=' + v.title + ':' + v.id).join(', ') || '(无)');

    const isRootNode = (node) => node && node.id !== undefined && rootIdSet.has(String(node.id));
    const stats = { created: 0, deleted: 0, renamed: 0, moved: 0 };

    const applyFolder = async (parentId, targetNodes, isRootLevel) => {
      const currentKids = await chrome.bookmarks.getChildren(parentId);
      const currentByFp = new Map();
      const currentFoldersByTitle = new Map();
      const currentRootsByKey = new Map(); // 根文件夹：归一化 key -> 浏览器节点
      for (const k of currentKids) {
        if (!k) continue;
        if (k.url) {
          const fp = BM.bookmarkFingerprint(k.url);
          if (fp) currentByFp.set(fp, k);
        } else {
          currentFoldersByTitle.set(k.title, k);
        }
      }
      // 根级别：直接使用识别的 browserRoots
      if (isRootLevel) {
        for (const [rk, node] of Object.entries(browserRoots)) {
          currentRootsByKey.set(rk, node);
          currentFoldersByTitle.delete(node.title);
        }
      } else {
        // 非根级别：也允许 title 匹配根别名（防御）
        for (const k of currentKids) {
          if (!k || k.url) continue;
          const rk = BM.rootKeyOf(k.title);
          if (rk) currentRootsByKey.set(rk, k);
        }
      }
      alog(`[applyFolder] parent=${parentId}${isRootLevel ? ' (根)' : ''} 现有${currentKids.length}项: ${currentKids.map(k => k.title + (k.url ? '' : '/')) .join(',') || '(空)'}`);

      const desiredChildren = [];
      for (const node of targetNodes) {
        if (node.url) {
          const fp = BM.bookmarkFingerprint(node.url);
          let bn = currentByFp.get(fp);
          if (!bn) {
            alog(`  [create] "${node.title}" ${node.url} 到 parent=${parentId}`);
            bn = await safeOp(() => chrome.bookmarks.create({
              parentId,
              title: node.title || '',
              url: node.url,
            }));
            if (bn) stats.created++;
          } else {
            currentByFp.delete(fp);
            if (bn.title !== node.title && node.title && !isRootNode(bn)) {
              await safeOp(() => chrome.bookmarks.update(bn.id, { title: node.title }));
              stats.renamed++;
            }
          }
          if (bn) desiredChildren.push({ node, bn });
        } else {
          // 文件夹：优先匹配浏览器根文件夹（处理本地化命名差异）
          let bn = null;
          const rk = BM.rootKeyOf(node.title);
          if (isRootLevel && rk && currentRootsByKey.has(rk)) {
            // 目标根文件夹 -> 映射到浏览器实际根文件夹
            bn = currentRootsByKey.get(rk);
            // 从待删除集合移除
            currentFoldersByTitle.delete(bn.title);
            alog(`  [root-map] "${node.title}"(${rk}) -> 浏览器 "${bn.title}" id=${bn.id}`);
          } else {
            bn = currentFoldersByTitle.get(node.title);
            if (!bn) {
              alog(`  [create-folder] "${node.title}" 到 parent=${parentId}`);
              bn = await safeOp(() => chrome.bookmarks.create({ parentId, title: node.title }));
              if (bn) stats.created++;
            } else {
              currentFoldersByTitle.delete(node.title);
            }
          }
          if (bn) {
            await applyFolder(bn.id, node.children || [], false);
            desiredChildren.push({ node, bn });
          }
        }
      }

      // 删除浏览器中多余的（不在目标里的）
      for (const fp of currentByFp.keys()) {
        const bn = currentByFp.get(fp);
        if (isRootNode(bn)) continue;
        await safeOp(() => chrome.bookmarks.remove(bn.id));
        stats.deleted++;
      }
      for (const title of currentFoldersByTitle.keys()) {
        const folder = currentFoldersByTitle.get(title);
        if (isRootNode(folder)) continue;
        await safeOp(() => chrome.bookmarks.removeTree(folder.id));
        stats.deleted++;
      }

      // 调整顺序（根级别不排序——书签栏/其他/移动的顺序由浏览器固定）
      if (isRootLevel) return;
      const afterKids = await chrome.bookmarks.getChildren(parentId);
      const afterByFp = new Map();
      const afterByTitle = new Map();
      const afterRootsByKey = new Map();
      for (const k of afterKids) {
        if (!k) continue;
        if (k.url) {
          const fp = BM.bookmarkFingerprint(k.url);
          if (fp) afterByFp.set(fp, k);
        } else {
          afterByTitle.set(k.title, k);
          const rk = BM.rootKeyOf(k.title);
          if (rk) afterRootsByKey.set(rk, k);
        }
      }
      let idx = 0;
      for (const item of desiredChildren) {
        let bn = null;
        if (item.node.url) {
          bn = afterByFp.get(BM.bookmarkFingerprint(item.node.url));
        } else {
          // 文件夹：先按标题，再用根别名兜底
          bn = afterByTitle.get(item.node.title) || null;
          if (!bn) {
            const rk = BM.rootKeyOf(item.node.title);
            if (rk) bn = afterRootsByKey.get(rk) || null;
          }
        }
        if (!bn) { idx++; continue; }
        if (isRootNode(bn)) { idx++; continue; }
        const children = await chrome.bookmarks.getChildren(parentId);
        const curIdx = children.findIndex((c) => c && c.id === bn.id);
        if (curIdx !== idx) {
          await safeOp(() => chrome.bookmarks.move(bn.id, { parentId, index: idx }));
          stats.moved++;
        }
        idx++;
      }
    };

    await applyFolder(rootId, targetTree, true);
    return stats;
  };

  // 暴露全局
  self.BookmarkMerge = BM;
})();
