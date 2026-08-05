/**
 * Options 页面逻辑：加载/保存 WebDAV 配置，测试连接，立即同步
 */

let browsePath = []; // 当前浏览路径（字符串数组），如 ['Foo', 'Bar']

async function loadSettings() {
  const data = await chrome.storage.local.get('config');
  const cfg = data.config;
  if (cfg) {
    document.getElementById('username').value = cfg.username || '';
    document.getElementById('appPassword').value = cfg.appPassword || '';
    document.getElementById('intervalMin').value = cfg.intervalMin || 15;
    document.getElementById('folder').value = cfg.folder || '';
  }
}

function setStatus(msg, ok) {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.className = ok ? 'ok' : 'err';
}

async function saveSettings(andSync) {
  const username = document.getElementById('username').value.trim();
  const appPassword = document.getElementById('appPassword').value.trim();
  const intervalMin = Math.max(1, parseInt(document.getElementById('intervalMin').value, 10) || 15);
  const folder = document.getElementById('folder').value.trim();

  if (!username || !appPassword) {
    setStatus('请填写用户名和应用密码', false);
    return;
  }

  const config = { username, appPassword, intervalMin, folder };
  await chrome.storage.local.set({ config });

  if (andSync) {
    const resp = await chrome.runtime.sendMessage({
      type: 'reconfigured',
      intervalMin,
    }).catch(() => null);
    setStatus('配置已保存，正在同步…', true);
  } else {
    setStatus('配置已保存', true);
  }
}

async function testConnection() {
  const username = document.getElementById('username').value.trim();
  const appPassword = document.getElementById('appPassword').value.trim();
  const folder = document.getElementById('folder').value.trim();
  if (!username || !appPassword) {
    setStatus('请先填写用户名和应用密码', false);
    return;
  }

  setStatus('正在测试连接…', true);
  try {
    const resp = await chrome.runtime.sendMessage({
      type: 'test_connection',
      username,
      appPassword,
      folder,
    });
    if (resp && resp.ok) {
      setStatus('连接成功 ✓ 可以开始同步了', true);
    } else {
      setStatus(`连接失败：${resp && resp.error ? resp.error : '未知错误'}`, false);
    }
  } catch (e) {
    setStatus(`连接失败：${e.message}`, false);
  }
}

// ---------- 目录浏览器 ----------

function getCredentials() {
  return {
    username: document.getElementById('username').value.trim(),
    appPassword: document.getElementById('appPassword').value.trim(),
  };
}

function pathString() {
  return browsePath.join('/');
}

async function openBrowser() {
  const { username, appPassword } = getCredentials();
  if (!username || !appPassword) {
    setStatus('请先填写用户名和应用密码，再浏览目录', false);
    return;
  }
  browsePath = [];
  const box = document.getElementById('browser');
  box.style.display = 'block';
  await renderBrowser();
}

async function renderBrowser() {
  const { username, appPassword } = getCredentials();
  const box = document.getElementById('browser');
  box.innerHTML = '';

  // 面包屑
  const crumb = document.createElement('div');
  crumb.className = 'crumb';
  const rootLink = document.createElement('a');
  rootLink.textContent = '根目录';
  rootLink.addEventListener('click', async () => {
    browsePath = [];
    await renderBrowser();
  });
  crumb.appendChild(rootLink);
  let acc = [];
  for (let i = 0; i < browsePath.length; i++) {
    crumb.appendChild(document.createTextNode(' / '));
    const seg = browsePath[i];
    const link = document.createElement('a');
    link.textContent = seg;
    const idx = i;
    link.addEventListener('click', async () => {
      browsePath = browsePath.slice(0, idx + 1);
      await renderBrowser();
    });
    crumb.appendChild(link);
    acc.push(seg);
  }
  box.appendChild(crumb);

  const list = document.createElement('ul');
  box.appendChild(list);

  const resp = await chrome.runtime.sendMessage({
    type: 'list_folders',
    username,
    appPassword,
    path: pathString(),
  });

  if (resp && resp.ok) {
    if (resp.folders.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'empty';
      empty.textContent = '（此目录下没有子文件夹）';
      list.appendChild(empty);
    }
    for (const folder of resp.folders) {
      const li = document.createElement('li');
      const icon = document.createElement('span');
      icon.className = 'dir-icon';
      icon.textContent = '📁';
      const label = document.createElement('span');
      label.textContent = folder;
      li.appendChild(icon);
      li.appendChild(label);
      li.addEventListener('click', async () => {
        browsePath.push(folder);
        await renderBrowser();
      });
      list.appendChild(li);
    }
  } else {
    const err = document.createElement('li');
    err.className = 'empty';
    err.textContent = '无法列出目录：' + ((resp && resp.error) || '未知错误');
    list.appendChild(err);
  }

  // 选择当前目录
  const selRow = document.createElement('div');
  selRow.className = 'sel-row';
  const useBtn = document.createElement('button');
  useBtn.textContent = '使用当前目录';
  useBtn.addEventListener('click', () => {
    document.getElementById('folder').value = pathString();
    box.style.display = 'none';
  });
  selRow.appendChild(useBtn);
  box.appendChild(selRow);
}

document.getElementById('saveBtn').addEventListener('click', () => saveSettings(true));
document.getElementById('testBtn').addEventListener('click', testConnection);
document.getElementById('browseBtn').addEventListener('click', openBrowser);

loadSettings();
