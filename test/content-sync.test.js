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
const { spawnSync, spawn } = require('node:child_process');

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
function cli(args, input, timeout = 20000, codeScript) {
  const stub = path.join(ROOT, 'stub-bin');
  fs.mkdirSync(stub, { recursive: true });
  fs.writeFileSync(path.join(stub, 'code'), codeScript || '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return spawnSync('node', [BIN, ...args], {
    env: { ...process.env, GWMW_CONFIG: CFG, PATH: `${stub}:${process.env.PATH}` },
    input, encoding: 'utf8', timeout,
  });
}

// 异步跑 CLI（用于「运行中从外部改文件」的用例：resolve 会自动推进）
function cliSpawn(args) {
  const stub = path.join(ROOT, 'stub-bin');
  fs.mkdirSync(stub, { recursive: true });
  fs.writeFileSync(path.join(stub, 'code'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const child = spawn('node', [BIN, ...args], {
    env: { ...process.env, GWMW_CONFIG: CFG, PATH: `${stub}:${process.env.PATH}` },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const done = new Promise((resolve) => child.on('close', (code) => resolve({ code, out })));
  return { child, done, output: () => out };
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

// ---------------------------------------------------------------------------
// ⑥ 检测到冲突就自动落盘 diff（mirror / flatten / diff / resolve 都要有）
// ---------------------------------------------------------------------------
function conflictArtifacts(name) {
  const dir = path.join(ROOT, '.content-sync', 'conflicts');
  return { dir, diff: path.join(dir, cs.safeConflictName(name) + '.diff'), index: path.join(dir, 'index.md') };
}

test('CLI：mirror 拦截时自动生成冲突 diff 文件', () => {
  baseline({ 'A.mw': 'v1\n' });
  const cp = contentPath('A.mw');
  write(cp, 'v2 content\n');
  write(path.join(FLAT, 'A.mw'), 'v3 flat\n');           // 两侧各自改 → 冲突

  const r = cli(['mirror']);
  assert.strictEqual(r.status, 1);
  const art = conflictArtifacts('A.mw');
  assert.match(r.stdout, /已生成冲突 diff/);
  assert.ok(fs.existsSync(art.diff), '应生成 <页>.diff');
  assert.ok(fs.existsSync(art.index), '应生成 index.md');
  const diff = fs.readFileSync(art.diff, 'utf8');
  assert.match(diff, /v3 flat/);
  assert.match(diff, /v2 content/);
  assert.match(r.stdout, new RegExp(art.dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), '应打印冲突 diff 目录');
  assert.match(r.stdout, /code --diff/);
});

test('CLI：flatten 拦截时自动生成冲突 diff 文件', () => {
  baseline({ 'A.mw': 'v1\n' });
  write(path.join(FLAT, 'A.mw'), 'v2 flat\n');           // 扁平未提交改动 + content 也不同
  write(contentPath('A.mw'), 'v3 content\n');

  const r = cli(['flatten']);
  assert.strictEqual(r.status, 1);
  const art = conflictArtifacts('A.mw');
  assert.match(r.stdout, /已生成冲突 diff/);
  assert.ok(fs.existsSync(art.diff));
  assert.ok(fs.existsSync(art.index));
});

test('CLI：diff 遇到冲突也自动生成 diff 文件', () => {
  baseline({ 'A.mw': 'v1\n' });
  write(contentPath('A.mw'), 'v2 content\n');
  write(path.join(FLAT, 'A.mw'), 'v3 flat\n');

  const r = cli(['diff']);
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /已生成冲突 diff/);
  assert.ok(fs.existsSync(conflictArtifacts('A.mw').diff));
});

test('CLI：resolve 启动时也把冲突 diff 落盘', () => {
  baseline({ 'A.mw': 'v1\n' });
  write(contentPath('A.mw'), 'v2 content\n');
  write(path.join(FLAT, 'A.mw'), 'v3 flat\n');

  cli(['resolve'], 'q\n');
  assert.ok(fs.existsSync(conflictArtifacts('A.mw').diff));
  assert.ok(fs.existsSync(conflictArtifacts('A.mw').index));
});

// ---------------------------------------------------------------------------
// ⑦ 更少指令：编辑到一致自动推进；改过 diff 后重跑命令自动复检写回
// ---------------------------------------------------------------------------
test('CLI：resolve 中把两侧改成一致 → 自动推进（无需回车）', async () => {
  baseline({ 'A.mw': 'v1\n' });
  const cp = contentPath('A.mw');
  write(cp, 'v2 content\n');
  write(path.join(FLAT, 'A.mw'), 'v3 flat\n');

  const { done, output } = cliSpawn(['resolve']);
  await new Promise((r) => setTimeout(r, 900));   // 等它进入等待状态
  write(cp, 'v3 flat\n');                        // 等价于在差异编辑器里把两侧改一致
  const res = await Promise.race([
    done, new Promise((r) => setTimeout(() => r({ code: null, out: output() }), 8000)),
  ]);
  assert.strictEqual(res.code, 0, '应自动走完并退出');
  assert.match(res.out, /两侧已一致，进入下一项/);
  assert.deepStrictEqual(cs.analyzePublish(FLAT, CONTENT, FLAT).conflict, []);
});

test('CLI：改过 diff 后重跑 flatten → 自动复检写回两侧并放行（无需 --force）', () => {
  baseline({ 'A.mw': 'v1\n' });
  const cp = contentPath('A.mw');
  write(cp, 'v2 content\n');
  write(path.join(FLAT, 'A.mw'), 'v3 flat\n');

  const refused = cli(['flatten']);                 // 第一次：拦截并生成 diff
  assert.strictEqual(refused.status, 1);
  const art = conflictArtifacts('A.mw');
  assert.ok(fs.existsSync(art.diff));

  // 用外部差异编辑器「解决」：把 diff 文件改成本页最终正文
  write(art.diff, 'v4 merged\n');
  const again = cli(['flatten']);
  assert.strictEqual(again.status, 0, again.stdout + again.stderr);
  assert.match(again.stdout, /被人工修改过：已复检并写回两侧/);
  assert.strictEqual(fs.readFileSync(path.join(FLAT, 'A.mw'), 'utf8'), 'v4 merged\n');
  assert.strictEqual(fs.readFileSync(cp, 'utf8'), 'v4 merged\n');
  assert.deepStrictEqual(cs.analyzePublish(FLAT, CONTENT, FLAT).conflict, []);
  assert.ok(!fs.existsSync(art.diff), '解决后 diff 应出账并归档');
  assert.ok(fs.existsSync(art.diff + '.done'), '归档为 <页>.diff.done');
});

test('CLI：diff 未改动 → 仍拦截，不自动放行', () => {
  baseline({ 'A.mw': 'v1\n' });
  write(contentPath('A.mw'), 'v2 content\n');
  write(path.join(FLAT, 'A.mw'), 'v3 flat\n');

  assert.strictEqual(cli(['flatten']).status, 1);
  const again = cli(['flatten']);                    // diff 原样没动
  assert.strictEqual(again.status, 1);
  assert.match(again.stdout, /仍有 1 个冲突未解决/);
  assert.strictEqual(fs.readFileSync(path.join(FLAT, 'A.mw'), 'utf8'), 'v3 flat\n');
});

test('CLI：人工结果含冲突标记/diff 结构 → 拒绝写回且两侧文件不被改坏', () => {
  baseline({ 'A.mw': 'v1\n' });
  const cp = contentPath('A.mw');
  write(cp, 'v2 content\n');
  write(path.join(FLAT, 'A.mw'), 'v3 flat\n');

  assert.strictEqual(cli(['flatten']).status, 1);
  const art = conflictArtifacts('A.mw');
  write(art.diff, '<<<<<<< flat\nv3 flat\n=======\nv2 content\n>>>>>>> content\n');
  const r = cli(['flatten']);
  assert.strictEqual(r.status, 1);
  assert.match(r.stdout, /还留有冲突标记/);
  assert.strictEqual(fs.readFileSync(path.join(FLAT, 'A.mw'), 'utf8'), 'v3 flat\n');
  assert.strictEqual(fs.readFileSync(cp, 'utf8'), 'v2 content\n');
  write(art.diff, '@@ -1 +1 @@\n-v3 flat\n+v2 content\n');
  const r2 = cli(['flatten']);
  assert.strictEqual(r2.status, 1);
  assert.match(r2.stdout, /仍是未处理的 diff/);
  assert.strictEqual(fs.readFileSync(path.join(FLAT, 'A.mw'), 'utf8'), 'v3 flat\n');
});

test('CLI：多个冲突只改了一个 → 已改的写回放行，未改的仍拦截且不受影响', () => {
  baseline({ 'A.mw': 'v1\n', 'B.mw': 'v1\n' });
  for (const n of ['A.mw', 'B.mw']) {
    write(contentPath(n), 'v2 content\n');
    write(path.join(FLAT, n), 'v3 flat\n');
  }
  assert.strictEqual(cli(['flatten']).status, 1);
  write(conflictArtifacts('A.mw').diff, 'merged A\n');   // 只解决 A

  const r = cli(['flatten']);
  assert.strictEqual(r.status, 1);                       // B 仍未解决 → 仍拦截
  assert.strictEqual(fs.readFileSync(path.join(FLAT, 'A.mw'), 'utf8'), 'merged A\n');
  assert.strictEqual(fs.readFileSync(contentPath('A.mw'), 'utf8'), 'merged A\n');
  assert.strictEqual(fs.readFileSync(path.join(FLAT, 'B.mw'), 'utf8'), 'v3 flat\n');   // B 保持原样
  assert.strictEqual(fs.readFileSync(contentPath('B.mw'), 'utf8'), 'v2 content\n');

  write(conflictArtifacts('B.mw').diff, 'merged B\n');   // 再解决 B → 放行
  const ok = cli(['flatten']);
  assert.strictEqual(ok.status, 0, ok.stdout + ok.stderr);
  assert.strictEqual(fs.readFileSync(path.join(FLAT, 'B.mw'), 'utf8'), 'merged B\n');
  assert.strictEqual(fs.readFileSync(contentPath('B.mw'), 'utf8'), 'merged B\n');
});

test('CLI：apply 只复检不跑同步（有遗留冲突则退出码 1）', () => {
  baseline({ 'A.mw': 'v1\n' });
  write(contentPath('A.mw'), 'v2 content\n');
  write(path.join(FLAT, 'A.mw'), 'v3 flat\n');
  assert.strictEqual(cli(['flatten']).status, 1);

  const pending = cli(['apply']);
  assert.strictEqual(pending.status, 1);
  assert.match(pending.stdout, /仍有 1 个冲突未解决/);

  write(conflictArtifacts('A.mw').diff, 'merged\n');
  const done = cli(['apply']);
  assert.strictEqual(done.status, 0, done.stdout + done.stderr);
  assert.match(done.stdout, /冲突均已解决/);
  assert.strictEqual(fs.readFileSync(path.join(FLAT, 'A.mw'), 'utf8'), 'merged\n');
  assert.strictEqual(fs.readFileSync(contentPath('A.mw'), 'utf8'), 'merged\n');
});

test('CLI：手工在两侧改成一致（未动 diff）→ 重跑命令自动放行', () => {
  baseline({ 'A.mw': 'v1\n' });
  const cp = contentPath('A.mw');
  write(cp, 'v2 content\n');
  write(path.join(FLAT, 'A.mw'), 'v3 flat\n');
  assert.strictEqual(cli(['flatten']).status, 1);

  write(cp, 'v3 flat\n');                        // 直接在两份真实文件里合并
  const r = cli(['flatten']);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /已无差异（两侧一致）/);
});

// ---------------------------------------------------------------------------
// ⑧ 不假设用户装了 VS Code：没有 code 命令时也要能用（记事本 / nano / vim）
// ---------------------------------------------------------------------------
// 只把 git 放进 PATH：模拟「本机没有 VS Code（code）」的环境
function cliWithoutCode(args, input, env = {}) {
  const bin = path.join(ROOT, 'git-only-bin');
  fs.mkdirSync(bin, { recursive: true });
  const git = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  fs.rmSync(path.join(bin, 'git'), { force: true });
  fs.symlinkSync(git, path.join(bin, 'git'));
  return spawnSync(process.execPath, [BIN, ...args], {
    env: { ...process.env, GWMW_CONFIG: CFG, PATH: bin, EDITOR: 'my-txt-editor', VISUAL: '', ...env },
    input, encoding: 'utf8', timeout: 20000,
  });
}

test('CLI：没有 code（VS Code）时冲突提示改为「改 diff + 编辑器」而非 code --diff', () => {
  baseline({ 'A.mw': 'v1\n' });
  write(contentPath('A.mw'), 'v2 content\n');
  write(path.join(FLAT, 'A.mw'), 'v3 flat\n');

  const r = cliWithoutCode(['flatten']);
  assert.strictEqual(r.status, 1);
  assert.match(r.stdout, /改这里/);
  assert.match(r.stdout, /\.diff/);
  assert.match(r.stdout, /记事本 \/ nano \/ vim/);
  assert.ok(!/code --diff/.test(r.stdout), '没有 code 时不应再提 code --diff');
});

test('CLI：没有 code 时 resolve 仍可用，并按 $EDITOR 给出打开命令', () => {
  baseline({ 'A.mw': 'v1\n' });
  write(contentPath('A.mw'), 'v2 content\n');
  write(path.join(FLAT, 'A.mw'), 'v3 flat\n');

  const r = cliWithoutCode(['resolve'], 'q\n');
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /my-txt-editor/);            // 用 $EDITOR，而不是 code
  assert.ok(!/code --diff/.test(r.stdout));
  assert.deepStrictEqual(cs.analyzePublish(FLAT, CONTENT, FLAT).conflict, ['A.mw']);   // 未解决仍是冲突
});

test('CLI：没有 code 时改 diff 重跑同样自动写回两侧（纯文本编辑器流程）', () => {
  baseline({ 'A.mw': 'v1\n' });
  const cp = contentPath('A.mw');
  write(cp, 'v2 content\n');
  write(path.join(FLAT, 'A.mw'), 'v3 flat\n');

  const refused = cliWithoutCode(['flatten']);
  assert.strictEqual(refused.status, 1);
  // 等价于「记事本打开 .diff，全选替换成最终正文，保存」
  write(conflictArtifacts('A.mw').diff, '纯文本编辑器合并结果\n');
  const again = cliWithoutCode(['flatten']);
  assert.strictEqual(again.status, 0, again.stdout + again.stderr);
  assert.strictEqual(fs.readFileSync(path.join(FLAT, 'A.mw'), 'utf8'), '纯文本编辑器合并结果\n');
  assert.strictEqual(fs.readFileSync(cp, 'utf8'), '纯文本编辑器合并结果\n');
});

// ---------------------------------------------------------------------------
// ⑨ 把冲突写进 git（VS Code 源代码管理面板 → 内置合并编辑器）
// ---------------------------------------------------------------------------
function unmerged() {
  return sh('git', ['diff', '--name-only', '--diff-filter=U'], FLAT).trim();
}

test('git-merge：把冲突写进 git（UU + 工作树带标记），未解决时不会提交', () => {
  baseline({ 'A.mw': 'v1\n' });
  const cp = contentPath('A.mw');
  write(cp, 'v2 content\n');
  write(path.join(FLAT, 'A.mw'), 'v3 flat\n');

  const made = cli(['git-merge']);
  assert.strictEqual(made.status, 0, made.stdout + made.stderr);
  assert.match(made.stdout, /已把 1 个冲突写进 git/);
  assert.strictEqual(unmerged(), 'A.mw');
  const marked = fs.readFileSync(path.join(FLAT, 'A.mw'), 'utf8');
  assert.match(marked, /^<{7}/m);
  assert.match(marked, /={7}/);
  assert.match(marked, /^>{7}/m);
  assert.match(marked, /v3 flat/);
  assert.match(marked, /v2 content/);
  assert.strictEqual(sh('git', ['status', '--porcelain'], FLAT).trim().slice(0, 2), 'UU');

  // 未解决：重跑同步/发布不能把带标记的文件写出去
  const blocked = cli(['flatten']);
  assert.strictEqual(blocked.status, 1);
  const head = sh('git', ['rev-parse', 'HEAD'], FLAT);
  assert.strictEqual(sh('git', ['rev-parse', 'HEAD'], FLAT), head, '不应产生新提交');
  assert.strictEqual(fs.readFileSync(cp, 'utf8'), 'v2 content\n');
});

test('git-merge：合并编辑器解决（写结果 + git add）后，重跑命令自动收尾同步 content/', () => {
  baseline({ 'A.mw': 'v1\n' });
  const cp = contentPath('A.mw');
  write(cp, 'v2 content\n');
  write(path.join(FLAT, 'A.mw'), 'v3 flat\n');
  assert.strictEqual(cli(['git-merge']).status, 0);

  // 等价于 VS Code 合并编辑器「完成合并」：写出结果并标记为已解决（git add）
  write(path.join(FLAT, 'A.mw'), '合并结果（来自合并编辑器）\n');
  sh('git', ['add', '--', 'A.mw'], FLAT);

  const r = cli(['flatten']);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /git 合并冲突已解决 1 个/);
  assert.strictEqual(fs.readFileSync(cp, 'utf8'), '合并结果（来自合并编辑器）\n');
  assert.strictEqual(unmerged(), '');
  assert.deepStrictEqual(cs.analyzePublish(FLAT, CONTENT, FLAT).conflict, []);
});

test('git-merge：只写结果、没 git add（未 stage）时收尾也能识别并清理', () => {
  baseline({ 'A.mw': 'v1\n' });
  const cp = contentPath('A.mw');
  write(cp, 'v2 content\n');
  write(path.join(FLAT, 'A.mw'), 'v3 flat\n');
  assert.strictEqual(cli(['git-merge']).status, 0);

  write(path.join(FLAT, 'A.mw'), '只保存未 stage 的结果\n');   // 模拟编辑器只保存
  const r = cli(['apply']);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.strictEqual(fs.readFileSync(cp, 'utf8'), '只保存未 stage 的结果\n');
  assert.strictEqual(unmerged(), '');
});

test('git-merge --abort：还原扁平侧工作树并清掉 unmerged，content/ 不受影响', () => {
  baseline({ 'A.mw': 'v1\n' });
  const cp = contentPath('A.mw');
  write(cp, 'v2 content\n');
  write(path.join(FLAT, 'A.mw'), 'v3 flat\n');
  assert.strictEqual(cli(['git-merge']).status, 0);
  assert.strictEqual(unmerged(), 'A.mw');

  const r = cli(['git-merge', '--abort']);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /已撤销 1 个 git 合并冲突/);
  assert.strictEqual(unmerged(), '');
  assert.strictEqual(fs.readFileSync(path.join(FLAT, 'A.mw'), 'utf8'), 'v3 flat\n');
  assert.strictEqual(fs.readFileSync(cp, 'utf8'), 'v2 content\n');
});

test('git-merge：二进制图片 / 删除类冲突跳过（仍走 diff 流程）', () => {
  baseline({ 'A.mw': 'v1\n' });
  write(contentPath('A.mw'), 'v2 content\n');
  write(path.join(FLAT, 'A.mw'), 'v3 flat\n');
  fs.rmSync(contentPath('A.mw'));                       // content 侧删页 → 缺一侧

  const r = cli(['git-merge']);
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /缺一侧/);
  assert.strictEqual(unmerged(), '');
  assert.strictEqual(fs.readFileSync(path.join(FLAT, 'A.mw'), 'utf8'), 'v3 flat\n');
});

// 全部跑完清理沙盒（失败时保留现场便于排查）
after(() => {
  if (!process.env.KEEP_TEST_SANDBOX) fs.rmSync(ROOT, { recursive: true, force: true });
  else console.log('沙盒保留在：' + ROOT);
});
