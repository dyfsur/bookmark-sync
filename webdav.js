/**
 * WebDAV 客户端 - 通过坚果云 WebDAV 读写书签数据文件
 * (MV3 Service Worker 环境，暴露全局 self.JianguoyunDAV)
 *
 * 支持自定义同步目录：cfg.folder 指定文件夹（如 '我的文档/Bookmarks'），
 * 留空则默认 'Bookmarks'。目录可嵌套，会自动创建。
 */

(function () {
  'use strict';

  const DAV = {};

  DAV.WEBDAV_BASE = 'https://dav.jianguoyun.com/dav/';
  DAV.DEFAULT_FOLDER = 'Bookmarks';
  DAV.BOOKMARKS_FILE = 'bookmarks_sync.json';
  DAV.LOCK_FILE = '.bookmarks_sync.lock';

  /** 生成 HTTP Basic Auth 头 */
  DAV.basicAuth = function (username, appPassword) {
    const token = btoa(`${username}:${appPassword}`);
    return `Basic ${token}`;
  };

  /** 计算书签文件路径 */
  DAV.bookmarksPath = function (folder) {
    const f = DAV.normalizeFolder(folder);
    return f ? f + '/' + DAV.BOOKMARKS_FILE : DAV.BOOKMARKS_FILE;
  };

  /** 计算锁文件路径 */
  DAV.lockPath = function (folder) {
    const f = DAV.normalizeFolder(folder);
    return f ? f + '/' + DAV.LOCK_FILE : DAV.LOCK_FILE;
  };

  /** 规范化目录：去首尾斜杠、折叠连续斜杠、去前导空格 */
  DAV.normalizeFolder = function (folder) {
    let f = (folder || '').trim();
    f = f.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\/+/g, '/');
    if (!f) return DAV.DEFAULT_FOLDER;
    return f;
  };

  /** 通用 WebDAV 请求 */
  DAV.davRequest = async function (cfg, method, path, body, extraHeaders = {}) {
    const headers = { 'Authorization': DAV.basicAuth(cfg.username, cfg.appPassword), ...extraHeaders };
    if (body !== undefined && body !== null) {
      headers['Content-Type'] = 'application/octet-stream';
    }
    const resp = await fetch(`${DAV.WEBDAV_BASE}${path}`, { method, headers, body });
    return resp;
  };

  /**
   * 确保目录存在（逐级创建）
   * @param {object} cfg { username, appPassword }
   * @param {string} folder 相对目录，如 'A/B'；空则创建默认目录
   */
  DAV.ensureDirectory = async function (cfg, folder) {
    const f = DAV.normalizeFolder(folder);
    const segs = f.split('/').filter(Boolean);
    let cur = '';
    for (const seg of segs) {
      cur = cur ? cur + '/' + seg : seg;
      try {
        const resp = await DAV.davRequest(cfg, 'MKCOL', cur + '/');
        // 201=创建成功 405=已存在 301/302=重定向（一般已存在）
        if (resp.status !== 201 && resp.status !== 405 && !(resp.status >= 300 && resp.status < 400)) {
          // 其他错误容忍：目录可能已由其他方式创建
        }
      } catch (e) {
        // 网络错误也容忍，后续 GET/PUT 会再次尝试
      }
    }
  };

  /**
   * 列出某个目录下的子文件夹（用于设置页浏览目录）
   * 注意：这里 path 是「浏览路径」，空串表示真正的坚果云根目录，
   *       不要调用 normalizeFolder（它会默认成 Bookmarks）。
   * @param {object} cfg { username, appPassword }
   * @param {string} folderPath 要列出的目录路径，'' = 根目录
   * @returns {Promise<{ok: boolean, folders: string[], status?: number, error?: string}>}
   */
  DAV.listFolders = async function (cfg, folderPath) {
    // 规范化浏览路径：去首尾斜杠、折叠连续斜杠；空 = 根
    let rel = (folderPath || '').trim().replace(/^\/+/, '').replace(/\/+$/, '').replace(/\/+/g, '/');
    const urlPath = rel ? rel + '/' : '';

    let resp;
    try {
      resp = await DAV.davRequest(cfg, 'PROPFIND', urlPath, undefined, {
        'Depth': '1',
        'Content-Type': 'application/xml',
      });
    } catch (e) {
      return { ok: false, error: e.message };
    }
    if (!resp.ok) {
      return { ok: false, status: resp.status, error: `HTTP ${resp.status}` };
    }
    const xml = await resp.text();

    // 解析每个 <response> 块：目录以 <resourcetype><collection/> 标识（坚果云标准返回）
    const folders = [];
    const responseRe = /<D?:response>([\s\S]*?)<\/D?:response>/g;
    let rm;
    while ((rm = responseRe.exec(xml)) !== null) {
      const block = rm[1];
      // 该块是否是集合（目录）
      const isCollection = /<D?:resourcetype>[\s\S]*?<D?:collection\s*\/?>/i.test(block);
      if (!isCollection) continue;
      // 提取 href
      const hrefMatch = block.match(/<D?:href>([^<]+)<\/D?:href>/i);
      if (!hrefMatch) continue;
      let h = hrefMatch[1].trim();
      // 去掉协议/域名前缀，变成相对路径
      h = h.replace(/^https?:\/\/[^/]+\/dav\//i, '').replace(/^\/?dav\//i, '');
      h = decodeURIComponent(h).replace(/\/+$/, ''); // 去尾部斜杠
      if (!h) continue;               // 根自身
      if (h === rel) continue;        // 当前目录自身
      // 只取「当前目录的直接子目录」：剥掉 rel 前缀后，剩余不能再含斜杠
      let rest = h;
      if (rel) {
        if (h.startsWith(rel + '/')) rest = h.slice(rel.length + 1);
        else continue;
      }
      if (!rest || rest.indexOf('/') >= 0) continue;
      folders.push(rest);
    }

    // 兜底：如果上面解析不出任何目录，退回按 href 尾部斜杠过滤
    if (folders.length === 0) {
      const hrefRe = /<D?:href>([^<]+)<\/D?:href>/gi;
      let hm;
      while ((hm = hrefRe.exec(xml)) !== null) {
        let h = hm[1].trim().replace(/^https?:\/\/[^/]+\/dav\//i, '').replace(/^\/?dav\//i, '');
        h = decodeURIComponent(h).replace(/\/+$/, '');
        if (!h || h === rel) continue;
        let rest = h;
        if (rel) {
          if (h.startsWith(rel + '/')) rest = h.slice(rel.length + 1);
          else continue;
        }
        if (!rest || rest.indexOf('/') >= 0) continue;
        folders.push(rest);
      }
    }

    // 去重排序
    const uniq = [...new Set(folders)];
    uniq.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return { ok: true, folders: uniq };
  };

  /** 规范化 ETag：去掉首尾引号和 W/ 前缀，统一成裸值 */
  DAV.normalizeEtag = function (etag) {
    if (!etag) return null;
    let e = String(etag).trim();
    // 去弱校验符 W/
    e = e.replace(/^W\//i, '');
    // 去首尾引号
    if (e.startsWith('"') && e.endsWith('"')) e = e.slice(1, -1);
    if (!e) return null;
    return e;
  };

  /** 读取远端书签文件 */
  DAV.readRemoteFile = async function (cfg) {
    const folder = DAV.normalizeFolder(cfg.folder);
    try { await DAV.ensureDirectory(cfg, folder); } catch (e) {}
    const resp = await DAV.davRequest(cfg, 'GET', DAV.bookmarksPath(folder));
    if (resp.status === 404) return { ok: false, status: 404 };
    if (!resp.ok) return { ok: false, status: resp.status };
    const etag = DAV.normalizeEtag(resp.headers.get('etag'));
    const text = await resp.text();
    try {
      const data = JSON.parse(text);
      return { ok: true, data, etag };
    } catch (e) {
      return { ok: false, status: -1, parseError: e.message };
    }
  };

  /** 写入远端书签文件（普通 PUT，不做条件写） */
  DAV.writeRemoteFile = async function (cfg, data) {
    const folder = DAV.normalizeFolder(cfg.folder);
    const body = JSON.stringify(data, null, 2);
    const headers = {
      'Content-Type': 'application/json; charset=utf-8',
    };
    const resp = await DAV.davRequest(cfg, 'PUT', DAV.bookmarksPath(folder), body, headers);
    if (resp.ok || resp.status === 204 || resp.status === 201) {
      const newEtag = DAV.normalizeEtag(resp.headers.get('etag'));
      return { ok: true, status: resp.status, etag: newEtag };
    }
    return { ok: false, status: resp.status };
  };

  /** 获取远端文件元信息 */
  DAV.getRemoteMeta = async function (cfg) {
    const folder = DAV.normalizeFolder(cfg.folder);
    const resp = await DAV.davRequest(cfg, 'PROPFIND', DAV.bookmarksPath(folder), undefined, {
      'Depth': '0',
      'Content-Type': 'application/xml',
    });
    if (resp.status === 404) return null;
    if (!resp.ok) return null;
    const xml = await resp.text();
    const lastModified = (xml.match(/<D:getlastmodified>([^<]+)<\/D:getlastmodified>/) ||
      xml.match(/<lp1:getlastmodified>([^<]+)<\/lp1:getlastmodified>/))?.[1] || '';
    const etag = (xml.match(/<D:getetag>([^<]+)<\/D:getetag>/) ||
      xml.match(/<lp1:getetag>([^<]+)<\/lp1:getetag>/))?.[1] || '';
    return { lastModified, etag };
  };

  /** 获取锁（独占创建） */
  DAV.acquireLock = async function (cfg, lockId) {
    const folder = DAV.normalizeFolder(cfg.folder);
    const body = JSON.stringify({ id: lockId, time: Date.now() });
    const resp = await DAV.davRequest(cfg, 'PUT', DAV.lockPath(folder), body, {
      'If-None-Match': '*',
      'Content-Type': 'application/json',
    });
    return resp.ok || resp.status === 201 || resp.status === 204;
  };

  /** 释放锁 */
  DAV.releaseLock = async function (cfg) {
    const folder = DAV.normalizeFolder(cfg.folder);
    await DAV.davRequest(cfg, 'DELETE', DAV.lockPath(folder));
  };

  /** 读取锁内容 */
  DAV.readLock = async function (cfg) {
    const folder = DAV.normalizeFolder(cfg.folder);
    const resp = await DAV.davRequest(cfg, 'GET', DAV.lockPath(folder));
    if (!resp.ok) return null;
    try {
      return JSON.parse(await resp.text());
    } catch (e) {
      return null;
    }
  };

  self.JianguoyunDAV = DAV;
})();
