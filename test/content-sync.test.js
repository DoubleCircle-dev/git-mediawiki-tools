'use strict';
/**
 * content-sync 冲突处理流程测试（零依赖：node:test + node:assert）
 *
 * 覆盖「content/ 内容树 ↔ 扁平仓库」的判定与冲突处置：
 *   ① 两侧一致 / 仅内容树改 / 仅扁平改 / 两侧各自改（冲突）/ 内容树删页
 *   ② 冲突产物：.content-sync/conflicts/<页>.diff（a=扁平仓库、b=content/）+ index.md
 *   ③ 冲突时 applyPublish 中止且**不改动任何文件**
 *   ④ resolve 交互流程：命令行喂 f（采用扁平→内容）/ c（采用内容→扁平）
 *   ⑤ index/布局冲突（X.mw 与 X/index.mw 并存）→ 直接中止
 *   ⑥ 往返映射一致、flatten 幂等、图片硬链接去重、CLI 子命令输出
 *
 * 全程在 os.tmpdir() 的沙盒里跑（临时 git 仓库），不碰真实仓库与线上。
 * 运行：npm test
 */
const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const BIN = path.join(__dirname, '..', 'bin', 'content-sync.js');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-test-'));
const FLAT = path.join(ROOT, 'flat');
const CONTENT = path.join(ROOT, 'content');
const CFG = path.join(ROOT, 'config.json');
const NAMESPACES = [
  'Talk', 'User', 'User_talk', 'Project', 'Project_talk', 'File', 'File_talk',
  'MediaWiki', 'MediaWiki_talk', 'Template', 'Template_talk', 'Help', 'Help_talk',
  'Category', 'Category_talk', 'Widget', 'Widget_talk', 'Module', 'Module_talk',
];
fs.writeFileSync(CFG, JSON.stringify({
  wikiName: 'sandbox', wikiRepo: FLAT, contentDir: CONTENT, namespaces: NAMESPACES,
}));
process.env.GWMW_CONFIG = CFG;   // config.js 在模块加载时读配置，必须先设环境变量再 require
const cs = require('../bin/content-sync.js');

// ---------------------------------------------------------------------------
// 沙盒工具
// ---------------------------------------------------------------------------
function sh(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `${cmd} ${args.join(' ')} 失败：${r.stderr}`);
  return r.stdout;
}

function reset() {
  for (const p of [FLAT, CONTENT, path.join(ROOT, '.content-sync')]) {
    fs.rmSync(p, { recursive: true, force: true });
  }
  fs.mkdirSync(FLAT, { recursive: true });
  fs.mkdirSync(CONTENT, { recursive: true });
  sh('git', ['init', '-q', '-b', 'master'], FLAT);
  sh('git', ['config', 'user.email', 'test@example.invalid'], FLAT);
  sh('git', ['config', 'user.name', 'test'], FLAT);
}

function write(p, text) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
}

function commit(msg) {
  sh('git', ['add', '-A'], FLAT);
  sh('git', ['commit', '-qm', msg], FLAT);
}

// 建基线：给定「扁平文件名 -> 内容」，两侧写同样内容并提交（HEAD = 基线）
function baseline(pages) {
  reset();
  const allMw = Object.keys(pages).filter((f) => f.endsWith('.mw'));
  for (const [flat, text] of Object.entries(pages)) {
    const rel = cs.mirrorRel(flat, allMw);
    write(path.join(FLAT, flat), text);
    write(path.join(CONTENT, rel), text);
  }
  commit('baseline');
}

// 内容树里某扁平文件名对应的路径
function contentPath(flat, allMw) {
  const mw = allMw || cs.listFlat(FLAT).mw;
  return path.join(CONTENT, cs.mirrorRel(flat, mw));
}

// 调 CLI（默认注入一个假 `code`，避免 resolve 真的打开差异编辑器）
function cli(args, input, timeout = 20000) {
  const stub = path.join(ROOT, 'stub-bin');
  fs.mkdirSync(stub, { recursive: true });
  fs.writeFileSync(path.join(stub, 'code'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return spawnSync('node', [BIN, ...args], {
    env: { ...process.env, GWMW_CONFIG: CFG, PATH: `${stub}:${process.env.PATH}` },
    input, encoding: 'utf8', timeout,
  });
}

// ---------------------------------------------------------------------------
// ① 判定矩阵
// ---------------------------------------------------------------------------
test('两侧一致 → 无待同步、无冲突', () => {
  baseline({ 'A.mw': 'v1\n' });
  const a = cs.analyzePublish(FLAT, CONTENT, FLAT);
  assert.deepStrictEqual(
    { flatten: a.flatten, deletion: a.deletion, refresh: a.refreshAfter, conflict: a.conflict },
    { flatten: [], deletion: [], refresh: [], conflict: [] });
});

test('仅内容树改动 → 待回写（flatten），applyPublish 可发布', () => {
  baseline({ 'A.mw': 'v1\n' });
  write(contentPath('A.mw'), 'v2 content\n');
  const a = cs.analyzePublish(FLAT, CONTENT, FLAT);
  assert.deepStrictEqual(a.conflict, []);
  assert.deepStrictEqual(a.flatten, ['A.mw']);
  const pub = cs.applyPublish(FLAT, CONTENT, FLAT);
  assert.strictEqual(pub.ok, true);
  assert.strictEqual(fs.readFileSync(path.join(FLAT, 'A.mw'), 'utf8'), 'v2 content\n');
});

test('仅扁平改动（内容树 = HEAD）→ 记为扁平新改动，不判冲突', () => {
  baseline({ 'A.mw': 'v1\n' });
  write(path.join(FLAT, 'A.mw'), 'v2 flat\n');   // 未提交
  const a = cs.analyzePublish(FLAT, CONTENT, FLAT);
  assert.deepStrictEqual(a.conflict, []);
  assert.deepStrictEqual(a.refreshAfter, ['A.mw']);
});

test('两侧各自修改 → 判冲突；applyPublish 中止且两侧文件都不被改写', () => {
  baseline({ 'A.mw': 'v1\n' });
  const cp = contentPath('A.mw');
  write(cp, 'v2 content\n');
  write(path.join(FLAT, 'A.mw'), 'v3 flat\n');
  const before = { flat: cs.sha1File(path.join(FLAT, 'A.mw')), content: cs.sha1File(cp) };

  const a = cs.analyzePublish(FLAT, CONTENT, FLAT);
  assert.deepStrictEqual(a.conflict, ['A.mw']);
  assert.deepStrictEqual(a.flatten, []);

  const pub = cs.applyPublish(FLAT, CONTENT, FLAT);
  assert.strictEqual(pub.ok, false);
  assert.deepStrictEqual(pub.conflict, ['A.mw']);
  assert.strictEqual(cs.sha1File(path.join(FLAT, 'A.mw')), before.flat, '扁平仓库不应被改写');
  assert.strictEqual(cs.sha1File(cp), before.content, '内容树不应被改写');
});

test('冲突产物：unified diff 含两侧文本，index.md 给出打开命令', () => {
  baseline({ 'A.mw': 'v1\n' });
  write(contentPath('A.mw'), 'v2 content\n');
  write(path.join(FLAT, 'A.mw'), 'v3 flat\n');
  const pub = cs.applyPublish(FLAT, CONTENT, FLAT);
  assert.strictEqual(pub.ok, false);
  assert.ok(pub.conflictDiffs.length >= 1, '应生成冲突 diff');
  const diff = fs.readFileSync(pub.conflictDiffs[0].diff, 'utf8');
  assert.match(diff, /v3 flat/, 'a 侧应为扁平仓库内容');
  assert.match(diff, /v2 content/, 'b 侧应为 content/ 内容');
  const index = fs.readFileSync(path.join(pub.conflictDir, 'index.md'), 'utf8');
  assert.match(index, /A\.mw/);
  assert.match(index, /code --diff/);
});

test('内容树删页 → 待删除；applyPublish 会从扁平仓库移除该页', () => {
  baseline({ 'A.mw': 'v1\n', 'B.mw': 'b1\n' });
  fs.rmSync(contentPath('B.mw'));
  const a = cs.analyzePublish(FLAT, CONTENT, FLAT);
  assert.deepStrictEqual(a.deletion, ['B.mw']);
  const pub = cs.applyPublish(FLAT, CONTENT, FLAT);
  assert.strictEqual(pub.ok, true);
  assert.strictEqual(fs.existsSync(path.join(FLAT, 'B.mw')), false);
});

// ---------------------------------------------------------------------------
// ② resolve 交互流程
// ---------------------------------------------------------------------------
test('resolve 输入 f：采用扁平仓库 → 覆盖 content/，冲突消失', () => {
  baseline({ 'A.mw': 'v1\n' });
  const cp = contentPath('A.mw');
  write(cp, 'v2 content\n');
  write(path.join(FLAT, 'A.mw'), 'v3 flat\n');

  cli(['resolve'], 'f\n\n\n\n');
  assert.strictEqual(fs.readFileSync(cp, 'utf8'), 'v3 flat\n');
  assert.deepStrictEqual(cs.analyzePublish(FLAT, CONTENT, FLAT).conflict, []);
});

test('resolve 输入 c：采用内容树 → 覆盖扁平仓库，冲突消失', () => {
  baseline({ 'A.mw': 'v1\n' });
  const cp = contentPath('A.mw');
  write(cp, 'v2 content\n');
  write(path.join(FLAT, 'A.mw'), 'v3 flat\n');

  cli(['resolve'], 'c\n\n\n\n');
  assert.strictEqual(fs.readFileSync(path.join(FLAT, 'A.mw'), 'utf8'), 'v2 content\n');
  assert.deepStrictEqual(cs.analyzePublish(FLAT, CONTENT, FLAT).conflict, []);
});

test('冲突解决后即可正常发布（内容树仍有新改动也能回写）', () => {
  baseline({ 'A.mw': 'v1\n' });
  const cp = contentPath('A.mw');
  write(cp, 'v2 content\n');
  write(path.join(FLAT, 'A.mw'), 'v3 flat\n');
  cli(['resolve'], 'f\n\n\n\n');          // 采用扁平 → content（两侧一致）
  // 注意：扁平工作树此时仍是「未提交改动」。真实流程里 publish 会先把当前状态提交成基线
  //（resolve 后立刻再改 content 而不先发布，会被视为「两侧各自改动」→ 冲突，属保守判定）。
  commit('resolve: adopt flat side');
  write(cp, 'v4 merged\n');                // 再在 content 上继续编辑
  const pub = cs.applyPublish(FLAT, CONTENT, FLAT);
  assert.strictEqual(pub.ok, true);
  assert.strictEqual(fs.readFileSync(path.join(FLAT, 'A.mw'), 'utf8'), 'v4 merged\n');
});

// ---------------------------------------------------------------------------
// ③ 布局/index 冲突
// ---------------------------------------------------------------------------
test('布局冲突（X.mw 与 X/index.mw 并存）→ 检出 dup 并拒绝发布', () => {
  reset();
  write(path.join(FLAT, 'Template:X.mw'), 'parent v1\n');
  write(path.join(FLAT, 'Template:X%2Fdoc.mw'), 'doc v1\n');
  write(path.join(CONTENT, 'Template/X.mw'), 'parent dup\n');
  write(path.join(CONTENT, 'Template/X/index.mw'), 'parent v1\n');
  write(path.join(CONTENT, 'Template/X/doc.mw'), 'doc v1\n');
  commit('baseline');

  const layout = cs.contentLayoutConflicts(CONTENT);
  assert.strictEqual(layout.dup.length, 1);
  assert.match(cs.layoutHints(layout)[0], /index冲突/);

  const flatBefore = fs.readFileSync(path.join(FLAT, 'Template:X.mw'), 'utf8');
  const pub = cs.applyPublish(FLAT, CONTENT, FLAT);
  assert.strictEqual(pub.ok, false);
  assert.ok(pub.indexConflicts.length >= 1);
  assert.match(pub.indexConflictHints.join('\n'), /请删除多余文件/);
  assert.strictEqual(fs.readFileSync(path.join(FLAT, 'Template:X.mw'), 'utf8'), flatBefore);
});

// ---------------------------------------------------------------------------
// ④ 往返映射 / 幂等 / 图片去重 / CLI
// ---------------------------------------------------------------------------
test('往返映射一致（mirrorRel ↔ flatName）、flatten 幂等、图片硬链接去重', () => {
  reset();
  write(path.join(FLAT, 'A.mw'), 'a\n');
  write(path.join(FLAT, 'Template:X.mw'), 'p\n');
  write(path.join(FLAT, 'Template:X%2Fdoc.mw'), 'd\n');
  write(path.join(FLAT, 'img.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  commit('baseline');

  const mw = cs.listFlat(FLAT).mw;
  for (const f of cs.listFlat(FLAT).mw.concat(cs.listFlat(FLAT).images)) {
    assert.strictEqual(cs.flatName(cs.mirrorRel(f, mw)), f, `往返不一致：${f}`);
  }
  assert.strictEqual(cs.mirrorRel('A.mw', mw), 'pages/A.mw');
  assert.strictEqual(cs.mirrorRel('Template:X.mw', mw), 'Template/X/index.mw');
  assert.strictEqual(cs.mirrorRel('img.png', mw), 'images/img.png');

  const mirror = cs.mirrorToContent(FLAT, CONTENT);
  assert.ok(mirror.created >= 4);
  const first = cs.flattenToFlat(FLAT, CONTENT);
  const second = cs.flattenToFlat(FLAT, CONTENT);
  assert.strictEqual(second.written, 0, 'flatten 应幂等（第二次无写入）');

  // 图片：content/ 与扁平仓库共享同一 inode（磁盘只存一份）
  const inoFlat = fs.statSync(path.join(FLAT, 'img.png')).ino;
  const inoContent = fs.statSync(path.join(CONTENT, 'images', 'img.png')).ino;
  assert.strictEqual(inoFlat, inoContent);
});

test('CLI：status 提示冲突并生成 diff，conflicts 列出，check 仍往返一致', () => {
  baseline({ 'A.mw': 'v1\n' });
  write(contentPath('A.mw'), 'v2 content\n');
  write(path.join(FLAT, 'A.mw'), 'v3 flat\n');

  const st = cli(['status']);
  assert.strictEqual(st.status, 0);
  assert.match(st.stdout, /冲突\(需人工\): 1/);
  assert.match(st.stdout, /\.content-sync/);

  const cf = cli(['conflicts']);
  assert.match(cf.stdout, /共 1 个冲突/);
  assert.match(cf.stdout, /code --diff/);

  const chk = cli(['check']);
  assert.strictEqual(chk.status, 0);
  assert.match(chk.stdout, /往返一致/);
});

test('CLI：无冲突时 conflicts 明确说明无冲突', () => {
  baseline({ 'A.mw': 'v1\n' });
  const cf = cli(['conflicts']);
  assert.match(cf.stdout, /无冲突/);
});

// ---------------------------------------------------------------------------
// ⑤ 覆盖预检：mirror / flatten 不得静默覆盖对侧改动
// ---------------------------------------------------------------------------
test('analyzeMirror/analyzeFlatten：分类「会被覆盖」的文件', () => {
  baseline({ 'A.mw': 'v1\n', 'B.mw': 'b1\n' });
  write(contentPath('A.mw'), 'v2 content\n');            // 仅 content 侧改
  write(path.join(FLAT, 'B.mw'), 'b2 flat\n');          // 仅扁平侧改（未提交）

  const m = cs.analyzeMirror(FLAT, CONTENT);
  assert.deepStrictEqual(m.overwrite.map((o) => [o.name, o.kind]), [['A.mw', 'content-dirty']]);
  assert.strictEqual(m.create, 0);

  const f = cs.analyzeFlatten(FLAT, CONTENT, FLAT);
  assert.deepStrictEqual(f.overwrite.map((o) => [o.name, o.kind]), [['B.mw', 'flat-dirty']]);
});

test('CLI：mirror 会回退 content 侧改动 → 报警并拒绝（--force 才继续）', () => {
  baseline({ 'A.mw': 'v1\n' });
  const cp = contentPath('A.mw');
  write(cp, 'v2 content\n');                             // 仅 content 侧改

  const refused = cli(['mirror']);
  assert.strictEqual(refused.status, 1, '未加 --force 应中止');
  assert.match(refused.stdout, /会覆盖 1 处/);
  assert.match(refused.stdout, /content\/ 侧本地改动会被回退/);
  assert.match(refused.stdout, /--force/);
  assert.strictEqual(fs.readFileSync(cp, 'utf8'), 'v2 content\n', 'content 不应被覆盖');

  const forced = cli(['mirror', '--force']);
  assert.strictEqual(forced.status, 0);
  assert.strictEqual(fs.readFileSync(cp, 'utf8'), 'v1\n', '--force 后按扁平侧覆盖');
});

test('CLI：mirror 的安全场景（仅扁平侧更新）不拦截', () => {
  baseline({ 'A.mw': 'v1\n' });
  write(path.join(FLAT, 'A.mw'), 'v2 flat\n');           // 仅扁平侧改
  const r = cli(['mirror']);
  assert.strictEqual(r.status, 0);
  assert.strictEqual(fs.readFileSync(contentPath('A.mw'), 'utf8'), 'v2 flat\n');
});

test('CLI：flatten 会覆盖扁平未提交改动 → 报警并拒绝（--force 才继续）', () => {
  baseline({ 'A.mw': 'v1\n' });
  write(path.join(FLAT, 'A.mw'), 'v2 flat\n');           // 扁平侧有未提交改动
  const refused = cli(['flatten']);
  assert.strictEqual(refused.status, 1);
  assert.match(refused.stdout, /扁平仓库有未提交改动，会被覆盖/);
  assert.strictEqual(fs.readFileSync(path.join(FLAT, 'A.mw'), 'utf8'), 'v2 flat\n');

  const forced = cli(['flatten', '--force']);
  assert.strictEqual(forced.status, 0);
  assert.strictEqual(fs.readFileSync(path.join(FLAT, 'A.mw'), 'utf8'), 'v1\n');
});

test('CLI：flatten 的安全场景（仅内容树改）不拦截', () => {
  baseline({ 'A.mw': 'v1\n' });
  write(contentPath('A.mw'), 'v2 content\n');
  const r = cli(['flatten']);
  assert.strictEqual(r.status, 0);
  assert.strictEqual(fs.readFileSync(path.join(FLAT, 'A.mw'), 'utf8'), 'v2 content\n');
});

// 全部跑完清理沙盒（失败时保留现场便于排查）
after(() => {
  if (!process.env.KEEP_TEST_SANDBOX) fs.rmSync(ROOT, { recursive: true, force: true });
  else console.log('沙盒保留在：' + ROOT);
});
