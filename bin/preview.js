#!/usr/bin/env node
/**
 * git-mediawiki-tools 预览模块（Node 版，可选）
 *
 * 在本地起一套 MediaWiki（php -S + SQLite）并把扁平仓库 / content/ 的页面导入，
 * 保存即刷新查看渲染；退出时自动精简本地版本历史。MediaWiki 本体必须由 PHP 运行，
 * 本脚本用 Node 负责：启停 php 子进程、监听文件、批量导入、content→扁平回写、退出精简。
 *
 * 子命令：
 *   node bin/preview.js start           启动 php -S + 文件监听（前台运行；Ctrl+C 退出自动精简）
 *   node bin/preview.js watch           仅启动文件监听（需外部已起 php -S）
 *   node bin/preview.js stop            停止监听与 php，并精简历史
 *   node bin/preview.js squash          仅精简本地 DB 历史（保留每页最新）
 *   node bin/preview.js import <f>...   一次性把给定 .mw / 图片导入预览
 *
 * 需要 config.json（或 GWMW_CONFIG）里配置 preview.*（见 config.example.json）。
 */
'use strict';

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const cfg = require('../lib/config.js').load();
const contentSync = require('./content-sync.js');

const P = cfg.preview;
const REPO = cfg.wikiRepo;
const CONTENT = cfg.contentDir;
const MW = P.mediawikiDir;
const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg'];
const SCAN_MS = 1000;
const PID_FILE = path.join(os.tmpdir(), 'gw-preview.pid');

const isImage = (n) => IMAGE_EXTS.includes(path.extname(n).toLowerCase());

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------
function php(args, cwd, opts = {}) {
  const r = spawnSync(P.phpBin || 'php', args, { cwd, encoding: 'utf8', ...opts });
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// content/ 绝对路径 → 页面标题（经 flatName，把 %2F 还原为 /）
function contentTitle(abs) {
  const rel = path.relative(CONTENT, abs).split(path.sep).join('/');
  if (rel.startsWith('..')) return null;
  const flat = contentSync.flatName(rel);
  if (!flat.endsWith('.mw')) return null;
  return flat.slice(0, -3).replace(/%2F/g, '/');
}

// 扁平 .mw 文件名 → 页面标题
function flatTitle(name) {
  try {
    return decodeURIComponent(name.slice(0, -3));
  } catch (e) {
    return name.slice(0, -3);
  }
}

// content/ 相对路径 → 扁平仓库文件路径（用于回写）
function flatPathFor(rel) {
  return path.join(REPO, contentSync.flatName(rel));
}

// ---------------------------------------------------------------------------
// 导入
// ---------------------------------------------------------------------------
function importManifest(entries) {
  if (!entries.length) return;
  const mf = path.join(os.tmpdir(), `gw-mw-${process.pid}-${Date.now()}.tsv`);
  fs.writeFileSync(mf, entries.map(([t, p]) => `${t}\t${p}`).join('\n') + '\n', 'utf8');
  const r = php([
    'maintenance/importPagesManifest.php', '--overwrite',
    '-u', P.adminUser, '-s', P.importSummary, mf,
  ], MW);
  if (r.out) console.log(r.out);
  if (r.code !== 0) console.log(`  ⚠️ 导入失败: ${(r.err || r.out).slice(-300)}`);
  fs.unlinkSync(mf);
}

function importImagesFrom(files) {
  const stage = P.imageStage && fs.existsSync(P.imageStage)
    ? P.imageStage
    : fs.mkdtempSync(path.join(os.tmpdir(), 'gw-mw-img-'));
  let copied = 0;
  for (const src of files) {
    if (!fs.existsSync(src)) continue;
    const dst = path.join(stage, path.basename(src).replace(/ /g, '_'));
    try { fs.copyFileSync(src, dst); copied++; } catch (e) { /* ignore */ }
  }
  if (!copied) { if (!P.imageStage) fs.rmSync(stage, { recursive: true, force: true }); return; }
  const r = php([
    'maintenance/importImages.php', '--user', P.adminUser,
    '--overwrite', '--summary', P.importSummary, stage,
  ], MW);
  if (r.out) console.log(r.out);
  if (!P.imageStage) fs.rmSync(stage, { recursive: true, force: true });
}

function importContentPages(absPages) {
  const entries = [];
  for (const p of absPages) {
    if (!fs.existsSync(p) || !p.endsWith('.mw')) continue;
    try { const t = contentTitle(p); if (t) entries.push([t, p]); }
    catch (e) { console.log(`  ⚠️ 跳过无法映射 ${path.relative(CONTENT, p)}: ${e.message}`); }
  }
  if (entries.length) {
    console.log(`  导入内容页 ${entries.length}: ${entries.map(([t]) => t).slice(0, 8).join('、')}`);
    importManifest(entries);
  }
}

function importFlat(files) {
  const pages = [], imgs = [];
  for (const f of files) {
    const abs = path.join(REPO, f);
    if (!fs.existsSync(abs)) continue;
    if (f.endsWith('.mw')) pages.push([flatTitle(f), abs]);
    else if (isImage(f)) imgs.push(abs);
  }
  if (pages.length) {
    console.log(`  导入扁平页面 ${pages.length}: ${pages.map(([t]) => t).slice(0, 8).join('、')}`);
    importManifest(pages);
  }
  if (imgs.length) { console.log(`  导入扁平图片 ${imgs.length}`); importImagesFrom(imgs); }
}

// content 变更的 .mw → 回写扁平仓库工作树（不 commit），冲突跳过
function backfillFlat(absPages) {
  if (P.noBackfill) return;
  const written = [], conflicts = [];
  for (const p of absPages) {
    if (!fs.existsSync(p) || !p.endsWith('.mw')) continue;
    const rel = path.relative(CONTENT, p).split(path.sep).join('/');
    if (rel.startsWith('..')) continue;
    let flat;
    try { flat = contentSync.flatName(rel); } catch (e) { continue; }
    const dst = path.join(REPO, flat);
    if (fs.existsSync(dst) && contentSync.sha1File(dst) === contentSync.sha1File(p)) continue;
    const st = git(['-c', 'core.quotepath=false', 'status', '--porcelain',
      '--untracked-files=no', '--', flat], REPO);
    if (st.out.trim()) { conflicts.push(flat); continue; }
    fs.copyFileSync(p, dst);
    written.push(flat);
  }
  if (written.length) console.log(`  ↪ 已回写扁平仓库 ${written.length}: ${written.slice(0, 8).join('、')}（未提交）`);
  if (conflicts.length) console.log(`  ⚠️ 回写冲突跳过 ${conflicts.length}: ${conflicts.slice(0, 8).join('、')}`);
}

// ---------------------------------------------------------------------------
// 监听
// ---------------------------------------------------------------------------
function scanContentState() {
  const state = {};
  if (!fs.existsSync(CONTENT)) return state;
  const walk = (dir, base) => {
    for (const n of fs.readdirSync(dir)) {
      if (n.startsWith('.')) continue;
      const abs = path.join(dir, n);
      const rel = base ? base + '/' + n : n;
      const st = fs.statSync(abs);
      if (st.isDirectory()) walk(abs, rel);
      else if (n.endsWith('.mw') || (rel.startsWith('images/') && isImage(n))) {
        state[rel] = [st.mtimeMs, st.size];
      }
    }
  };
  walk(CONTENT, '');
  return state;
}

async function contentPoller(stop) {
  let base = null;
  let first = true;
  while (!stop()) {
    const cur = scanContentState();
    if (base === null) {
      if (first) {
        // 启动对齐：全量导入 content 的页面与图片，避免“启动前已改却未导入”漏导
        // （页面/图片都幂等：未变自动跳过）
        first = false;
        const pages = [], imgs = [];
        for (const rel of Object.keys(cur)) {
          const abs = path.join(CONTENT, ...rel.split('/'));
          if (rel.endsWith('.mw')) pages.push(abs);
          else if (rel.startsWith('images/')) imgs.push(abs);
        }
        if (pages.length) {
          console.log(`启动对齐：导入 content 页面 ${pages.length} 个（未变自动跳过）...`);
          importContentPages(pages);
        }
        if (imgs.length) {
          console.log(`启动对齐：导入 content 图片 ${imgs.length} 个（未变自动跳过）...`);
          importImagesFrom(imgs);
        }
      }
      base = cur;
      await sleep(SCAN_MS);
      continue;
    }
    const changed = [];
    for (const rel of Object.keys(cur)) {
      if (JSON.stringify(base[rel]) !== JSON.stringify(cur[rel])) changed.push(rel);
    }
    base = cur;
    if (changed.length) {
      const pages = changed.filter((r) => r.endsWith('.mw'))
        .map((r) => path.join(CONTENT, ...r.split('/')));
      const imgs = changed.filter((r) => r.startsWith('images/'))
        .map((r) => path.join(CONTENT, ...r.split('/')));
      console.log(`内容树变更 ${changed.length} 个文件，导入...`);
      importContentPages(pages);
      backfillFlat(pages);
      if (imgs.length) { console.log(`  导入内容图片 ${imgs.length}`); importImagesFrom(imgs); }
    }
    await sleep(SCAN_MS);
  }
}

async function flatWatcher(stop) {
  if (!fs.existsSync(REPO)) return;
  let watcher;
  try {
    watcher = fs.watch(REPO, { persistent: false }, (evt, name) => {
      if (!name) return;
      if (name.endsWith('.mw') || isImage(name)) queueFlat(name);
    });
  } catch (e) {
    console.log('  ⚠️ fs.watch 不可用（扁平仓库改用轮询）', e.message);
    const last = new Map();
    while (!stop()) {
      for (const n of fs.readdirSync(REPO)) {
        if (n.startsWith('.')) continue;
        if (!(n.endsWith('.mw') || isImage(n))) continue;
        const st = fs.statSync(path.join(REPO, n));
        const key = `${n}:${st.mtimeMs}:${st.size}`;
        if (last.get(n) && last.get(n) !== key) queueFlat(n);
        last.set(n, key);
      }
      await sleep(500);
    }
    return;
  }
  // 主循环仅用于保持进程存活 / 处理 stop
  while (!stop()) await sleep(500);
  try { watcher.close(); } catch (e) { /* ignore */ }
}

let flatTimer = null;
const flatPending = new Set();
function queueFlat(name) {
  flatPending.add(name);
  if (flatTimer) clearTimeout(flatTimer);
  flatTimer = setTimeout(() => {
    const files = [...flatPending].sort();
    flatPending.clear();
    if (files.length) {
      console.log(`扁平变更 ${files.length} 个文件，导入...`);
      importFlat(files);
    }
  }, 500);
}

// ---------------------------------------------------------------------------
// 精简历史（Node 调 php 执行 SQLite 清理；预览环境必有 PHP）
// ---------------------------------------------------------------------------
const SQUASH_PHP = String.raw`<?php
$db = $argv[1] ?? '';
if (!$db || !is_file($db)) { fwrite(STDERR, "db not found: $db\n"); exit(1); }
$p = new PDO('sqlite:' . $db);
$p->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
$p->exec('BEGIN IMMEDIATE');
$before = (int)$p->query('SELECT count(*) FROM revision')->fetchColumn();
$p->exec('DELETE FROM revision WHERE rev_id NOT IN (SELECT page_latest FROM page)');
$arc = $p->exec('DELETE FROM archive');
$p->exec('DELETE FROM slots WHERE slot_revision_id NOT IN (SELECT rev_id FROM revision)');
$p->exec('DELETE FROM content WHERE content_id NOT IN (SELECT slot_content_id FROM slots) AND content_id NOT IN (SELECT slot_origin FROM slots)');
$p->exec("DELETE FROM text WHERE old_id NOT IN (SELECT CAST(substr(content_address, 4) AS INTEGER) FROM content WHERE content_address LIKE 'tt:%')");
$p->exec('COMMIT');
$after = (int)$p->query('SELECT count(*) FROM revision')->fetchColumn();
$p->exec('VACUUM');
echo "历史精简: revision $before -> $after, archive 清 $arc 条\n";
`;

function squashDb() {
  if (!P.dbFile) {
    console.log('  （未配置 preview.dbFile，跳过精简）');
    return;
  }
  if (!fs.existsSync(P.dbFile)) {
    console.log(`  ⚠️ 数据库不存在，跳过精简: ${P.dbFile}`);
    return;
  }
  const phpFile = path.join(os.tmpdir(), `gw-squash-${process.pid}.php`);
  fs.writeFileSync(phpFile, SQUASH_PHP, 'utf8');
  const r = php([phpFile, P.dbFile], '/');
  if (r.out) console.log(`  ${r.out}`);
  if (r.err) console.log(`  ${r.err}`);
  fs.unlinkSync(phpFile);
}

// ---------------------------------------------------------------------------
// start / watch 守护
// ---------------------------------------------------------------------------
async function runGuard(watchOnly) {
  if (!fs.existsSync(CONTENT) && !fs.existsSync(REPO)) {
    console.log('❌ 既无 content/ 也无扁平仓库目录，无法监听。请先配置 wikiRepo/contentDir。');
    process.exit(1);
  }
  let stopped = false;
  const stop = () => stopped;

  if (!watchOnly) {
    if (!MW || !fs.existsSync(MW)) {
      console.log(`❌ preview.mediawikiDir 无效或未配置: ${MW || ''}`);
      console.log('   （只做监听可先外部起 php，再用子命令 watch）');
      process.exit(1);
    }
    // 端口占用检测
    const probe = spawnSync(P.phpBin || 'php', ['-r', `$s=@stream_socket_server('tcp://127.0.0.1:${P.port}', $e, $m); echo $s?'free':'busy';`]);
    if (probe.stdout && probe.stdout.toString().trim() === 'busy') {
      console.log(`⚠️ 端口 ${P.port} 已被占用（似乎已有预览在跑？）。用 node bin/preview.js stop 后重试。`);
      process.exit(1);
    }
    console.log(`===== 启动本地预览 http://127.0.0.1:${P.port}（MediaWiki: ${MW}）=====`);
    const phpProc = spawn(P.phpBin || 'php', ['-S', `127.0.0.1:${P.port}`], {
      cwd: MW, stdio: ['ignore', 'inherit', 'inherit'],
    });
    process.on('exit', () => { try { phpProc.kill('SIGTERM'); } catch (e) { /* */ } });
  }

  const p1 = contentPoller(stop);
  const p2 = flatWatcher(stop);
  console.log('监听中：content/（轮询）与扁平仓库（变更）→ 导入预览；Ctrl+C 停止');
  console.log(`  pid 文件: ${PID_FILE}`);
  fs.writeFileSync(PID_FILE, String(process.pid), 'utf8');

  const shutdown = async () => {
    if (stopped) return;
    stopped = true;
    console.log('\n停止监听并精简历史...');
    try { fs.unlinkSync(PID_FILE); } catch (e) { /* */ }
    squashDb();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  await Promise.all([p1, p2]);
}

// ---------------------------------------------------------------------------
// 子命令
// ---------------------------------------------------------------------------
async function main() {
  const cmd = process.argv[2] || 'help';
  if (cmd === 'start') await runGuard(false);
  else if (cmd === 'watch') await runGuard(true);
  else if (cmd === 'stop') {
    // 1) 先让守护优雅退出（会杀其 php 子进程并精简）
    try {
      const pid = fs.readFileSync(PID_FILE, 'utf8').trim();
      if (pid) { process.kill(Number(pid), 'SIGTERM'); }
    } catch (e) { /* 守护未运行 */ }
    // 2) 兜底：按端口结束 php（兼容由旧方式/外部启动的预览），并清理 pid 文件
    try { spawnSync('pkill', ['-f', `php -S 127.0.0.1:${P.port}`]); } catch (e) { /* */ }
    try { fs.unlinkSync(PID_FILE); } catch (e) { /* */ }
    squashDb();
    console.log('已停止预览（历史已精简）');
  } else if (cmd === 'squash') squashDb();
  else if (cmd === 'import') {
    const files = process.argv.slice(3);
    if (!files.length) { console.log('用法: node bin/preview.js import <file|dir>...'); process.exit(1); }
    const contentAbs = [], flatNames = [];
    const contentRoot = path.resolve(CONTENT);
    for (const f of files) {
      const p = path.resolve(f);
      if (!fs.existsSync(p)) continue;
      if (fs.statSync(p).isDirectory()) {
        for (const n of fs.readdirSync(p)) {
          const a = path.join(p, n);
          if (!(n.endsWith('.mw') || isImage(n))) continue;
          if (a.startsWith(contentRoot + path.sep)) contentAbs.push(a);
          else if (fs.existsSync(path.join(REPO, n))) flatNames.push(n);
        }
      } else if (p.startsWith(contentRoot + path.sep)) contentAbs.push(p);
      else if (fs.existsSync(path.join(REPO, path.basename(p)))) flatNames.push(path.basename(p));
    }
    if (contentAbs.length) importContentPages(contentAbs);
    if (flatNames.length) importFlat([...new Set(flatNames)]);
    if (!contentAbs.length && !flatNames.length) console.log('（无可导入文件）');
  } else {
    console.log('用法: node bin/preview.js start|watch|stop|squash|import <file>...');
    console.log('（需在 config.json 配置 preview.*，见 config.example.json）');
  }
}

main();
