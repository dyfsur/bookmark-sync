/**
 * merge.js 核心算法测试
 * 运行：node tests/merge.test.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const sandbox = {
  self: {},
  URL,
  btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
  atob: (s) => Buffer.from(s, 'base64').toString('binary'),
  console,
};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(
  fs.readFileSync(path.join(__dirname, '..', 'merge.js'), 'utf8'),
  sandbox
);
const BM = sandbox.self.BookmarkMerge;

let passed = 0;
let failed = 0;
function assert(cond, name) {
  if (cond) { passed++; console.log('PASS', name); }
  else { failed++; console.log('FAIL', name); }
}

// --- normalizeUrl ---
assert(BM.normalizeUrl('https://example.com/a') === 'https://example.com/a', 'no-change url');
assert(BM.normalizeUrl('https://example.com/a/') === 'https://example.com/a', 'trailing slash');
assert(BM.normalizeUrl('https://example.com:443/a') === 'https://example.com/a', 'default https port');
assert(BM.normalizeUrl('http://example.com:80/a') === 'http://example.com/a', 'default http port');
assert(BM.normalizeUrl('https://example.com/a?b=2&a=1') === 'https://example.com/a?a=1&b=2', 'sorted query');
assert(BM.normalizeUrl('https://example.com/a#sec') === 'https://example.com/a', 'hash removed');
assert(BM.normalizeUrl('example.com/x') === 'https://example.com/x', 'scheme added');

// --- fingerprint ---
assert(BM.bookmarkFingerprint('https://a.com/x') === BM.bookmarkFingerprint('https://a.com/x/'), 'fingerprint ignores trailing slash');
assert(BM.bookmarkFingerprint('https://a.com/x?c=1&b=2') === BM.bookmarkFingerprint('https://a.com/x?b=2&c=1'), 'fingerprint ignores query order');

// --- dedupe ---
const tree = [{ title: 'F', children: [
  { title: 'A', url: 'https://x.com', created: 1 },
  { title: 'B', url: 'https://x.com', created: 2 },
  { title: 'C', url: 'https://y.com', created: 3 },
]}];
const { tree: deduped, moved } = BM.dedupeTree(tree);
assert(moved.length === 1, 'dedupe moves 1 dup');
assert(deduped.some(n => n.title === '重复书签'), 'dup folder created');
const dupFolder = deduped.find(n => n.title === '重复书签');
assert(dupFolder.children.length === 1, 'dup folder has 1 child');

// --- merge ---
const local = [{ title: 'LF', children: [
  { title: 's', url: 'https://s.com', created: 100 },
  { title: 'x', url: 'https://x.com', created: 200 },
]}];
const remote = [{ title: 'RF', children: [
  { title: 's', url: 'https://s.com', created: 50 },
]}];
const { tree: merged } = BM.mergeTrees(local, remote, new Map());
assert(merged.some(n => n.title === 'LF'), 'local folder kept');
assert(merged.some(n => n.title === 'RF'), 'remote folder kept');
const lf = merged.find(n => n.title === 'LF');
assert(lf.children.some(c => c.url === 'https://x.com'), 'local-only bookmark added');
const rf = merged.find(n => n.title === 'RF');
assert(rf.children.some(c => c.url === 'https://s.com'), 'remote bookmark kept');

// --- tombstone ---
const delHash = BM.bookmarkFingerprint('https://deleted.com');
const tb = new Map([[delHash, Date.now() - 1000]]);
const r2 = BM.mergeTrees([{ title: 'x', url: 'https://deleted.com', created: 1 }], [], tb);
assert(r2.tree.length === 0, 'tombstone blocks recent deletion');

const tbOld = new Map([[delHash, Date.now() - 31 * 24 * 3600 * 1000]]);
const r3 = BM.mergeTrees([{ title: 'x', url: 'https://deleted.com', created: 1 }], [], tbOld);
assert(r3.tree.length === 1, 'old tombstone expires');

// --- folder tombstone ---
// 场景：本地没有该文件夹，远端有（且被墓碑标记）→ 应删除（删除传播）
const tbFold = new Map([['/GoneFolder', Date.now() - 1000]]);
const r4 = BM.mergeTrees([], [{ title: 'GoneFolder', children: [] }], tbFold);
assert(r4.tree.length === 0, 'folder tombstone blocks remote-only folder');

// 场景：本地有该文件夹（用户当前拥有）→ 即使墓碑命中，也应保留（新建优先）
const tbFold2 = new Map([['/MyFolder', Date.now() - 1000]]);
const r4b = BM.mergeTrees(
  [{ title: 'MyFolder', children: [], created: Date.now() }],
  [],
  tbFold2
);
assert(r4b.tree.length === 1, 'locally-present folder kept despite tombstone');

// --- 删除传播（跨设备） ---
const t_initial = [{ title: '书签栏', children: [
  { title: 'Keep', url: 'https://keep.com', created: 100 },
  { title: 'Del', url: 'https://del.com', created: 200 },
]}];

// A 删除 Del
const tb_del = new Map();
tb_del.set(BM.bookmarkFingerprint('https://del.com'), Date.now());
const mergedA = BM.mergeTrees(t_initial, JSON.parse(JSON.stringify(t_initial)), tb_del).tree;
assert(!mergedA.some(n => n.children && n.children.some(c => c.url === 'https://del.com')), 'A 删掉后不复活');

// B 同步：A 的墓碑 + 远端(旧树还有 Del) -> B 也删掉
const mergedB = BM.mergeTrees(JSON.parse(JSON.stringify(t_initial)), JSON.parse(JSON.stringify(t_initial)), tb_del).tree;
assert(!mergedB.some(n => n.children && n.children.some(c => c.url === 'https://del.com')), 'B 收到墓碑后删除');

// 墓碑过期后放行
const tb_expired = new Map();
tb_expired.set(BM.bookmarkFingerprint('https://del.com'), Date.now() - 31 * 24 * 3600 * 1000);
const mergedC = BM.mergeTrees([{ title: '书签栏', children: [{ title: 'Del', url: 'https://del.com', created: 200 }] }], [], tb_expired).tree;
assert(mergedC.some(n => n.children && n.children.some(c => c.url === 'https://del.com')), '墓碑过期后允许重新添加');

// --- 根文件夹本地化别名 ---
assert(BM.rootKeyOf('书签栏') === 'bar', 'rootKeyOf 书签栏');
assert(BM.rootKeyOf('收藏夹栏') === 'bar', 'rootKeyOf 收藏夹栏');
assert(BM.rootKeyOf('其他书签') === 'other', 'rootKeyOf 其他书签');
assert(BM.rootKeyOf('其他收藏夹') === 'other', 'rootKeyOf 其他收藏夹');
assert(BM.rootKeyOf('移动设备书签') === 'mobile', 'rootKeyOf 移动设备书签');
assert(BM.rootKeyOf('移动收藏夹') === 'mobile', 'rootKeyOf 移动收藏夹');
assert(BM.rootKeyOf('普通文件夹') === null, 'rootKeyOf 普通文件夹为 null');

// 合并：Edge(收藏夹栏) + Chrome(书签栏) -> 应合并为一个，不是两个
const edgeRoots = [
  { title: '收藏夹栏', children: [{ title: 'GitHub', url: 'https://github.com', created: 100 }] },
  { title: '其他收藏夹', children: [] },
  { title: '移动收藏夹', children: [] },
];
const chromeRoots = [
  { title: '书签栏', children: [{ title: '默认书签', url: 'https://example.com', created: 50 }] },
  { title: '其他书签', children: [] },
  { title: '移动设备书签', children: [] },
];
const mergedRoots = BM.mergeTrees(edgeRoots, chromeRoots, new Map()).tree;
assert(mergedRoots.length === 3, '根文件夹别名合并后只有 3 个顶层');
const barNode = mergedRoots.find(n => BM.rootKeyOf(n.title) === 'bar');
assert(barNode && barNode.children.some(c => c.url === 'https://github.com'), 'GitHub 在合并后的书签栏');
assert(barNode && barNode.children.some(c => c.url === 'https://example.com'), '默认书签也在合并后的书签栏');

// 合并后整体去重
const mergedRoots2 = BM.mergeTrees(edgeRoots, chromeRoots, new Map()).tree;
assert(mergedRoots2.length === 3, '根文件夹别名合并后只有 3 个顶层');

// --- 嵌套空文件夹删除 ---
const tb_nested = new Map();
tb_nested.set('/bar/A', Date.now() - 1000);
tb_nested.set('/bar/A/B', Date.now() - 1000);
const remote_nested = [
  { title: '收藏夹栏', children: [
    { title: 'A', children: [{ title: 'B', children: [] }] },
  ]},
  { title: '其他收藏夹', children: [] },
  { title: '移动收藏夹', children: [] },
];
const local_nested = [
  { title: '收藏夹栏', children: [] },
  { title: '其他收藏夹', children: [] },
  { title: '移动收藏夹', children: [] },
];
const merged_nested = BM.mergeTrees(local_nested, remote_nested, tb_nested).tree;
const bar_nested = merged_nested.find(n => BM.rootKeyOf(n.title) === 'bar');
assert(bar_nested && !bar_nested.children.some(c => c.title === 'A'), '嵌套空文件夹 A 被删除后不复活');

// --- 嵌套空文件夹删除跨设备（路径归一化） ---
const tb_nested2 = new Map();
tb_nested2.set('/bar/A', Date.now() - 1000);
tb_nested2.set('/bar/A/B', Date.now() - 1000);
const chrome_local_nested = [
  { title: '书签栏', children: [
    { title: 'A', children: [{ title: 'B', children: [] }] },
  ]},
  { title: '其他书签', children: [] },
  { title: '移动设备书签', children: [] },
];
const merged_nested2 = BM.mergeTrees(chrome_local_nested, remote_nested, tb_nested2).tree;
const bar_nested2 = merged_nested2.find(n => BM.rootKeyOf(n.title) === 'bar');
assert(bar_nested2 && !bar_nested2.children.some(c => c.title === 'A'), '跨设备（书签栏/收藏夹栏）嵌套空文件夹删除生效');

// --- 只删内层 B，保留外层 A ---
const tb_nested3 = new Map();
tb_nested3.set('/bar/A/B', Date.now() - 1000);
const remote_nested3 = [
  { title: '收藏夹栏', children: [
    { title: 'A', children: [{ title: 'B', children: [] }, { title: 'Keep', url: 'https://k.com', created: 100 }] },
  ]},
  { title: '其他收藏夹', children: [] },
  { title: '移动收藏夹', children: [] },
];
const local_nested3 = [
  { title: '收藏夹栏', children: [
    { title: 'A', children: [{ title: 'Keep', url: 'https://k.com', created: 100 }] },
  ]},
  { title: '其他收藏夹', children: [] },
  { title: '移动收藏夹', children: [] },
];
const merged_nested3 = BM.mergeTrees(local_nested3, remote_nested3, tb_nested3).tree;
const A3 = merged_nested3.find(n => BM.rootKeyOf(n.title) === 'bar').children.find(c => c.title === 'A');
assert(A3 && !A3.children.some(c => c.title === 'B'), '删内层空文件夹 B，保留 A');
assert(A3 && A3.children.some(c => c.title === 'Keep'), 'Keep 书签保留');

// --- normalizeRootPath ---
assert(BM.normalizeRootPath('/收藏夹栏/A') === '/bar/A', 'normalizeRootPath 收藏夹栏');
assert(BM.normalizeRootPath('/书签栏/A') === '/bar/A', 'normalizeRootPath 书签栏');
assert(BM.normalizeRootPath('/其他收藏夹/x') === '/other/x', 'normalizeRootPath 其他收藏夹');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
