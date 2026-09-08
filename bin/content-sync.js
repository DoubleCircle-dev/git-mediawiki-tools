'use strict';
/**
 * 内容同步模块：扁平 git-mediawiki 仓库（由 config.json 指定） <-> content/（目录树）
 * 双向无损转换，供 sync / publish 脚本集成，也可作命令行直接调用。
 *
 * 背景：git-mediawiki 协议要求 .mw 页面以「命名空间:标题.mw」扁平放在仓库根目录
 * （标题里 `/` -> %2F、空格 -> _）。直接把文件移入子目录会破坏线上同步，
 * 因此用「内容树(content/) + 回写」方案：
 *   - content/ 是按命名空间整理的编辑工作区（pages/ 主命名空间、images/ 二进制图）
 *   - 扁平仓库保持扁平，专用于 git-mediawiki 同步
 *
 * 目录约定：
 *   pages/         主命名空间（无前缀）
 *   <命名空间>/    子页面解码为真实子目录；既是页面又有子页面的父页面 -> <目录>/index.mw
 *   images/        二进制图片
 *
 * 安全原则：绝不静默覆盖“两侧同时改动”的内容；检测到冲突会返回给调用方决定。
 *
 * 命令行用法：
 *   node bin/content-sync.js mirror|flatten|status|check|dedupe-images [--flat DIR] [--content DIR]
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const MW_EXT = '.mw';
const MAIN_NS = '(Main)';
const MAIN_FOLDER = 'pages';
const IMAGE_FOLDER = 'images';
const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg'];
// 受管命名空间来自配置（config.json 的 namespaces）；未提供时用内置默认集合
const cfg = require('../lib/config.js').load();
const KNOWN_NAMESPACES = new Set(cfg.namespaces);
const ALLOWED_UNMANAGED = new Set(['README.md', 'README.txt', '.gitkeep', '.content-format']);

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------
function isImage(name) {
  const ext = path.extname(name).toLowerCase();
  return IMAGE_EXTS.includes(ext);
}

function sha1Buf(buf) {
  return crypto.createHash('sha1').update(buf).digest('hex');
}
function sha1File(p) {
  return sha1Buf(fs.readFileSync(p));
}
function copyIfChanged(src, dst) {
  const sb = sha1File(src);
  if (fs.existsSync(dst) && sha1File(dst) === sb) return false;
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  return true;
}

// 图片去重：content/images 中与扁平仓库一致的图片，替换成指向扁平文件的硬链接，
// 使两侧共享同一份数据（磁盘只存一份）。跨设备/权限失败时自动回退为普通副本。
function dedupeImages(flatDir, contentDir) {
  let linked = 0, skipped = 0;
  if (!fs.existsSync(flatDir) || !fs.existsSync(contentDir)) return { linked, skipped };
  const { images } = listFlat(flatDir);
  for (const name of images) {
    const src = path.join(flatDir, name);          // 规范 inode：扁平仓库（git 跟踪）
    const dst = path.join(contentDir, IMAGE_FOLDER, name);
    if (!fs.existsSync(src) || !fs.existsSync(dst)) { skipped++; continue; }
    if (sha1File(src) !== sha1File(dst)) { skipped++; continue; } // 内容不一致不能链接
    try {
      if (fs.statSync(src).ino === fs.statSync(dst).ino) { skipped++; continue; } // 已链接
      const tmp = dst + '.tmp' + process.pid;
      fs.linkSync(src, tmp);        // 先在 dst 同目录建临时硬链接
      fs.renameSync(tmp, dst);      // 原子替换 dst（旧 inode 释放）
      linked++;
    } catch (e) {
      skipped++;                    // 跨设备等：保持普通副本
    }
  }
  return { linked, skipped };
}

// ---------------------------------------------------------------------------
// 扫描
// ---------------------------------------------------------------------------
function listFlat(flatDir) {
  const mw = [], images = [];
  if (!fs.existsSync(flatDir)) return { mw, images };
  for (const n of fs.readdirSync(flatDir)) {
    if (n.startsWith('.')) continue;
    const p = path.join(flatDir, n);
    if (!fs.statSync(p).isFile()) continue;
    if (n.endsWith(MW_EXT)) mw.push(n);
    else if (isImage(n)) images.push(n);
  }
  mw.sort();
  images.sort();
  return { mw, images };
}

function walkRel(root, dir, base, out) {
  for (const n of fs.readdirSync(dir)) {
    const abs = path.join(dir, n);
    const rel = base ? base + '/' + n : n;
    if (fs.statSync(abs).isDirectory()) {
      if (!n.startsWith('.')) walkRel(root, abs, rel, out);
    } else {
      out.push(rel);
    }
  }
  return out;
}

// 扫描内容树：返回 { map: Map(rel -> isPage), unmanaged: [rel] }
function scanContent(contentDir) {
  const map = new Map(), unmanaged = [];
  if (!fs.existsSync(contentDir)) return { map, unmanaged };
  const rels = walkRel(contentDir, contentDir, '', []);
  for (const rel of rels) {
    const name = rel.split('/').pop();
    if (name.startsWith('.')) continue;
    if (name.endsWith(MW_EXT)) map.set(rel, true);
    else if (rel.startsWith(IMAGE_FOLDER + '/')) map.set(rel, false);
    else if (rel.indexOf('/') === -1 && ALLOWED_UNMANAGED.has(name)) continue;
    else unmanaged.push(rel);
  }
  return { map, unmanaged };
}

// ---------------------------------------------------------------------------
// 标题/路径编解码（与 content_manage.py 一致）
// ---------------------------------------------------------------------------
function splitFlatMw(name) {
  let stem = name.slice(0, -MW_EXT.length);
  let ns = MAIN_NS, body = stem;
  const ci = stem.indexOf(':');
  if (ci > 0) {
    const prefix = stem.slice(0, ci);
    if (KNOWN_NAMESPACES.has(prefix)) {
      ns = prefix;
      body = stem.slice(ci + 1);
    }
  }
  const segs = body ? body.split('%2F') : [];
  return { ns, segs };
}

function isParentFlat(name, allMw) {
  const key = name.slice(0, -MW_EXT.length);
  return allMw.some((g) => g !== name && g.slice(0, -MW_EXT.length).startsWith(key + '%2F'));
}

// 扁平文件名 -> 内容树相对路径
function mirrorRel(name, allMw) {
  if (name.endsWith(MW_EXT)) {
    const { ns, segs } = splitFlatMw(name);
    const folder = ns === MAIN_NS ? MAIN_FOLDER : ns;
    if (!segs.length) throw new Error('无法解析页面文件名: ' + name);
    if (allMw.length && isParentFlat(name, allMw)) {
      return folder + '/' + segs.join('/') + '/index.mw';
    }
    return folder + '/' + segs.join('/') + MW_EXT;
  }
  if (isImage(name)) return IMAGE_FOLDER + '/' + name;
  throw new Error('不受管理的文件: ' + name);
}

// 内容树相对路径 -> 扁平文件名（可反向校验）
function flatName(rel) {
  const parts = rel.split('/');
  if (!parts.length || !parts[0]) throw new Error('空路径: ' + rel);
  if (parts[0] === IMAGE_FOLDER) return parts.slice(1).join('/');
  let ns, folder;
  if (parts[0] === MAIN_FOLDER) {
    ns = '';
    folder = parts.slice(1);
  } else {
    if (!KNOWN_NAMESPACES.has(parts[0])) throw new Error('无法识别的命名空间目录: ' + parts[0]);
    ns = parts[0];
    folder = parts.slice(1);
  }
  if (!folder.length) throw new Error('空路径: ' + rel);
  let segs;
  if (folder[folder.length - 1] === 'index.mw') segs = folder.slice(0, -1);
  else segs = folder.slice(0, -1).concat([folder[folder.length - 1].slice(0, -MW_EXT.length)]);
  return (ns ? ns + ':' : '') + segs.join('%2F') + MW_EXT;
}

// ---------------------------------------------------------------------------
// git 辅助
// ---------------------------------------------------------------------------
function gitRun(repo, args) {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}

// 工作树里所有有未提交改动的路径（含未跟踪），返回 Set（去掉重命名前缀）
function gitDirty(repo) {
  const r = gitRun(repo, ['-c', 'core.quotepath=false', 'status', '--porcelain', '--untracked-files=all']);
  const s = new Set();
  for (const line of r.out.split('\n')) {
    if (!line.trim()) continue;
    let p = line.slice(3);
    const arrow = p.indexOf(' -> ');
    if (arrow > 0) p = p.slice(arrow + 4); // 重命名：XY old -> new
    s.add(p.trim());
  }
  return s;
}

// HEAD 中跟踪的文件路径集合（受管理页名）
function gitTracked(repo) {
  const r = gitRun(repo, ['-c', 'core.quotepath=false', 'ls-tree', '-r', '--name-only', 'HEAD']);
  return new Set(r.out.split('\n').filter(Boolean));
}

// HEAD:<path> 的 sha1；文件不存在返回 null
function sha1Head(repo, name) {
  const r = spawnSync('git', ['show', 'HEAD:' + name], { cwd: repo });
  if (r.status !== 0) return null;
  return sha1Buf(r.stdout);
}

// ---------------------------------------------------------------------------
// 基本镜像 / 回写（与 content_manage.py 行为一致）
// ---------------------------------------------------------------------------
function entriesFromFlat(flatDir) {
  const { mw, images } = listFlat(flatDir);
  const all = mw.concat(images);
  const entries = new Map(); // rel -> flat name
  for (const f of all) entries.set(mirrorRel(f, mw), f);
  return { entries, mw, images };
}

// 扁平 -> 内容树（写目录树；不删除；自动对一致的图片做硬链接去重）
function mirrorToContent(flatDir, contentDir, opts = {}) {
  const { entries } = entriesFromFlat(flatDir);
  let created = 0, updated = 0, unchanged = 0;
  for (const [rel, flat] of [...entries].sort()) {
    const src = path.join(flatDir, flat);
    const dst = path.join(contentDir, rel);
    if (fs.existsSync(dst)) {
      if (sha1File(src) === sha1File(dst)) { unchanged++; continue; }
      updated++;
    } else created++;
    if (!opts.dryRun) copyIfChanged(src, dst);
  }
  const d = opts.dryRun ? { linked: 0, skipped: 0 } : dedupeImages(flatDir, contentDir);
  return { created, updated, unchanged, deduped: d.linked };
}

// 内容树 -> 扁平（写根目录；不删除；skip 参数可跳过某些扁平文件名）
function flattenToFlat(flatDir, contentDir, opts = {}) {
  const { map } = scanContent(contentDir);
  const skip = opts.skip || new Set();
  const targets = new Map(); // flat -> rel
  const dup = [];
  for (const rel of [...map.keys()]) {
    let flat;
    try { flat = flatName(rel); } catch (e) { continue; }
    if (targets.has(flat)) { dup.push([flat, rel]); continue; }
    targets.set(flat, rel);
  }
  let written = 0, unchanged = 0;
  for (const [flat, rel] of [...targets].sort()) {
    if (skip.has(flat)) continue;
    const src = path.join(contentDir, rel);
    const dst = path.join(flatDir, flat);
    if (fs.existsSync(dst) && sha1File(src) === sha1File(dst)) { unchanged++; continue; }
    written++;
    if (!opts.dryRun) copyIfChanged(src, dst);
  }
  return { written, unchanged, skipped: skip.size, dup };
}

// 内容树相对路径 -> 对应扁平文件名的存在映射（用于内容侧遍历）
function contentNameMap(contentDir) {
  const { map, unmanaged } = scanContent(contentDir);
  const out = new Map(); // flat name -> rel
  const bad = [];
  for (const rel of map.keys()) {
    try { out.set(flatName(rel), rel); } catch (e) { bad.push(rel); }
  }
  return { byFlat: out, unmanaged, bad };
}

// 扁平侧 + 内容侧 的当前字节 sha1（懒加载缓存）
function buildState(flatDir, contentDir) {
  const flat = listFlat(flatDir);
  const flatNames = flat.mw.concat(flat.images);
  const byFlat = contentNameMap(contentDir).byFlat;
  const flatCache = new Map();
  const contentCache = new Map();
  const getFlat = (name) => {
    if (!flatCache.has(name)) {
      const p = path.join(flatDir, name);
      flatCache.set(name, fs.existsSync(p) ? sha1File(p) : null);
    }
    return flatCache.get(name);
  };
  const getContent = (name) => {
    if (!contentCache.has(name)) {
      const rel = byFlat.get(name);
      contentCache.set(name, rel && fs.existsSync(path.join(contentDir, rel))
        ? sha1File(path.join(contentDir, rel)) : null);
    }
    return contentCache.get(name);
  };
  const hasContent = (name) => byFlat.has(name);
  return { flatNames, getFlat, getContent, hasContent, byFlat };
}

// ---------------------------------------------------------------------------
// 分析：发布（内容树 -> 扁平）前的按文件决策
// 返回 { flatten: [], deletion: [], refreshAfter: [], conflict: [], contentOnly:[], note:[] }
// ---------------------------------------------------------------------------
function analyzePublish(flatDir, contentDir, repo) {
  const state = buildState(flatDir, contentDir);
  const dirty = gitDirty(repo);
  const tracked = gitTracked(repo);
  const all = new Set(state.flatNames.concat([...state.byFlat.keys()]));

  const flatten = [], deletion = [], refreshAfter = [], conflict = [], flatOnly = [];
  for (const name of [...all].sort()) {
    const F = state.getFlat(name);           // 扁平工作树
    const C = state.getContent(name);        // 内容树
    const fDirty = dirty.has(name);
    const trackedName = tracked.has(name);
    const isMw = name.endsWith(MW_EXT);
    const managedImage = isImage(name);

    // 1) 两侧都在
    if (F !== null && C !== null) {
      if (F === C) continue;                 // 一致
      if (!fDirty) {
        // 扁平未改动 -> 以内容树为准
        if (isMw || managedImage) flatten.push(name);
        continue;
      }
      // 扁平有未提交改动：区分“只在扁平改” vs “两侧都改”
      const head = trackedName ? sha1Head(repo, name) : null;
      if (head !== null && head === C) {
        refreshAfter.push(name);             // 内容树 = HEAD（旧）=> 扁平侧新改，发布后刷新内容树
      } else if (head === null && C !== null) {
        refreshAfter.push(name);             // 扁平新增未跟踪文件且内容树也有 -> 视为扁平侧新内容
      } else {
        conflict.push(name);                 // 两侧都独立改动，无法自动合并
      }
      continue;
    }

    // 2) 只在扁平（内容树缺）
    if (F !== null && C === null) {
      if (fDirty) {
        if (trackedName) conflict.push(name);  // 改了已跟踪页，内容树却删了 -> 意图冲突
        else refreshAfter.push(name);          // 扁平新增（未跟踪）-> 发布后补内容树
      } else {
        if (trackedName) deletion.push(name);  // 内容树删页 -> 从扁平删除以发布删除
        else flatOnly.push(name);              // 已跟踪？未跟踪且干净少见，忽略
      }
      continue;
    }

    // 3) 只在内容（扁平缺）
    if (F === null && C !== null) {
      if (trackedName) conflict.push(name);    // 扁平工作树删了已跟踪页，内容树还在 -> 冲突
      else flatten.push(name);                 // 内容树新页 -> 回写新增
      continue;
    }

    // 4) 两侧都缺但 HEAD 有（flat 工作树已删）
    if (trackedName) deletion.push(name);      // 已从扁平删除 -> 提交即发布删除
  }
  return { flatten, deletion, refreshAfter, conflict, flatOnly };
}

// ---------------------------------------------------------------------------
// 发布：执行内容树 -> 扁平（含删除）；有冲突返回 false
// ---------------------------------------------------------------------------
function applyPublish(flatDir, contentDir, repo, opts = {}) {
  const a = analyzePublish(flatDir, contentDir, repo);
  if (a.conflict.length) return { ok: false, conflict: a.conflict };
  let written = 0, deleted = 0;
  if (!opts.dryRun) {
    for (const name of a.flatten) {
      const rel = contentNameMap(contentDir).byFlat.get(name);
      if (rel) written += copyIfChanged(path.join(contentDir, rel), path.join(flatDir, name)) ? 1 : 0;
    }
    for (const name of a.deletion) {
      const p = path.join(flatDir, name);
      if (fs.existsSync(p)) { fs.unlinkSync(p); deleted++; }
    }
  }
  const d = opts.dryRun ? { linked: 0, skipped: 0 } : dedupeImages(flatDir, contentDir);
  return { ok: true, flatten: a.flatten, deletion: a.deletion, refreshAfter: a.refreshAfter,
           written, deleted, deduped: d.linked };
}

// ---------------------------------------------------------------------------
// 同步（拉取线上后）：刷新内容树 = 扁平（含新增；跳过“内容树删页”以免复活；跳过内容侧待发布改动）
// ---------------------------------------------------------------------------
function refreshContentFromFlat(flatDir, contentDir, repo, opts = {}) {
  const state = buildState(flatDir, contentDir);
  const tracked = gitTracked(repo);
  let added = 0, updated = 0, skippedDelete = 0;
  const deletion = [];
  for (const name of state.flatNames) {
    const F = state.getFlat(name);
    const C = state.getContent(name);
    if (C === null) {
      // 内容树缺：HEAD 有 -> 疑似内容树删页（不复活）；否则 -> 新增补上
      if (tracked.has(name)) { skippedDelete++; deletion.push(name); continue; }
      const rel = mirrorRel(name, state.flatNames.filter((n) => n.endsWith(MW_EXT)));
      if (!opts.dryRun) copyIfChanged(path.join(flatDir, name), path.join(contentDir, rel));
      added++;
      continue;
    }
    if (F === C) continue;
    // 内容树与扁平不同：这里假定内容树 = 旧状态（调用方已确认无待发布内容），刷新为扁平
    const rel = state.byFlat.get(name);
    if (!opts.dryRun && rel) copyIfChanged(path.join(flatDir, name), path.join(contentDir, rel));
    updated++;
  }
  const d = opts.dryRun ? { linked: 0, skipped: 0 } : dedupeImages(flatDir, contentDir);
  return { added, updated, skippedDelete, deletion, deduped: d.linked };
}

// 待发布的本地位移（内容树相对扁平有改动且不是删除），用于 sync 前检查
function pendingLocalEdits(flatDir, contentDir) {
  const state = buildState(flatDir, contentDir);
  const out = [];
  for (const name of [...new Set([...state.flatNames, ...state.byFlat.keys()])].sort()) {
    const F = state.getFlat(name);
    const C = state.getContent(name);
    if (C !== null && F !== null && C !== F) out.push(name);
    else if (C !== null && F === null) out.push(name);   // 内容树新页未回写
  }
  return out;
}

// ---------------------------------------------------------------------------
// 命令行入口（与 content_manage.py 对齐的轻量实现）
// ---------------------------------------------------------------------------
function cli() {
  const argv = process.argv.slice(2);
  // 找出命令（忽略 --opt 及其取值），兼容选项在命令前/后
  const known = ['mirror', 'flatten', 'status', 'check', 'dedupe-images'];
  let cmd = argv.find((a) => known.includes(a));
  cmd = cmd || argv[0];
  const optOf = (k) => {
    const i = argv.indexOf('--' + k);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : undefined;
  };
  const dry = argv.includes('--dry-run');
  const flatDir = optOf('flat') || cfg.wikiRepo;
  const contentDir = optOf('content') || cfg.contentDir;
  const repo = flatDir;

  if (cmd === 'mirror') {
    const s = mirrorToContent(flatDir, contentDir, { dryRun: dry });
    console.log(`mirror: 新建 ${s.created}, 更新 ${s.updated}, 未变 ${s.unchanged}`
      + `, 图片去重 ${s.deduped}${dry ? '（dry-run）' : ''}`);
  } else if (cmd === 'flatten') {
    const s = flattenToFlat(flatDir, contentDir, { dryRun: dry });
    const d = dry ? 0 : dedupeImages(flatDir, contentDir).linked;
    console.log(`flatten: 写入 ${s.written}, 未变 ${s.unchanged}, 图片去重 ${d}${dry ? '（dry-run）' : ''}`);
    if (s.dup.length) console.log(`⚠️ 映射冲突 ${s.dup.length} 个（未写入）：`, s.dup.map(([f, r]) => `${r}->${f}`));
  } else if (cmd === 'dedupe-images') {
    const d = dedupeImages(flatDir, contentDir);
    console.log(`图片去重: 硬链接 ${d.linked} 张，跳过 ${d.skipped} 张`);
  } else if (cmd === 'status') {
    const a = analyzePublish(flatDir, contentDir, repo);
    const pend = pendingLocalEdits(flatDir, contentDir);
    const flat = listFlat(flatDir);
    const content = scanContent(contentDir);
    console.log(`扁平: ${flat.mw.length} 页 + ${flat.images.length} 图  |  内容树: ${content.map.size} 条`);
    console.log(`- 内容树待回写(flatten): ${a.flatten.length}`, a.flatten.slice(0, 15));
    console.log(`- 待删除(flatten/deletion): ${a.deletion.length}`, a.deletion.slice(0, 15));
    console.log(`- 扁平新改动(发布后刷新内容): ${a.refreshAfter.length}`, a.refreshAfter.slice(0, 15));
    console.log(`- 冲突(需人工): ${a.conflict.length}`, a.conflict.slice(0, 15));
    if (pend.length) console.log(`⚠️ 内容树有未发布改动: ${pend.length}`, pend.slice(0, 15));
  } else if (cmd === 'check') {
    const { mw, images } = listFlat(flatDir);
    const names = mw.concat(images);
    let err = 0;
    for (const f of names) {
      const rel = mirrorRel(f, mw);
      try { if (flatName(rel) !== f) { console.log('往返不一致', rel, f); err++; } }
      catch (e) { console.log('错误', rel, e.message); err++; }
    }
    console.log(`check: ${mw.length} 页 + ${images.length} 图，${err ? '发现问题 ' + err + ' 处 ✗' : '往返一致 ✓'}`);
  } else {
    console.log('用法: node content-sync.js mirror|flatten|status|check|dedupe-images [--flat DIR] [--content DIR] [--dry-run]');
  }
}

if (require.main === module) cli();

module.exports = {
  isImage, sha1File, copyIfChanged, dedupeImages,
  listFlat, scanContent, mirrorRel, flatName, splitFlatMw,
  gitDirty, gitTracked, sha1Head,
  mirrorToContent, flattenToFlat, contentNameMap, buildState,
  analyzePublish, applyPublish, refreshContentFromFlat, pendingLocalEdits,
};
