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
 *   node bin/content-sync.js mirror|flatten|status|check|conflicts|resolve|dedupe-images [--flat DIR] [--content DIR]
 *
 *   conflicts 命令在检测到“两侧各自改同一页”的冲突时，为每个冲突页生成统一差异
 *   冲突时不自动合并，而是把「两侧各自改」的差异写成文本文件（unified diff）到
 *   <内容树同级>/.content-sync/conflicts/：用任何文本编辑器（记事本 / nano / vim）
 *   把 <页>.diff 整份替换成最终正文并保存，重跑同步命令即自动复检、写回两侧；
 *   也支持在 diff／合并工具里对照（各命令会打印可选对照方式）。
 *   resolve 命令逐个停在命令行等你处理：两侧改到一致就自动进入下一项。
 *   即自动推进，也可输入 f/c 直接由命令行采用一侧——可视化编辑与命令行修改同步进行。
 *   diff 命令列出“本地待同步差异”（内容树待回写 + 扁平新改动）并给出每文件
 *   code --diff 查看命令，供同步/发布前在差异编辑器里核对。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync, spawn } = require('child_process');

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
// content 树布局 / index 冲突检测
// ---------------------------------------------------------------------------
// 规范（与 mirrorRel 一致）：既是页面又有子页面的父页面必须存为 <目录>/index.mw。
// 若 <...>/X.mw 与 <...>/X/index.mw 并存，会映射到同一扁平页面 X —— 此前会被
// contentNameMap 的 set() 静默覆盖、造成“改了不生效 / 读到旧版”的隐患，故集中检测：
//   dup      [{flat, rels}] 同一扁平名被多个 content 页占用（真实 index 冲突）
//   nonIndex [rel]          父页面以顶层 <...>/X.mw 存放（缺 X/index.mw）
//   loneIndex [rel]         X/index.mw 但目录下无子页（应改回普通 <...>/X.mw）
function contentLayoutConflicts(contentDir) {
  const { map } = scanContent(contentDir);
  const rels = [...map.keys()].filter((r) => r.endsWith(MW_EXT));
  const flatOf = (r) => { try { return flatName(r); } catch (e) { return null; } };
  const byFlat = new Map();
  for (const rel of rels) {
    const f = flatOf(rel);
    if (f === null) continue;
    if (!byFlat.has(f)) byFlat.set(f, []);
    byFlat.get(f).push(rel);
  }
  const dup = [];
  for (const [flat, list] of byFlat) if (list.length > 1) dup.push({ flat, rels: list });

  // 与扁平仓库往返一致的位置才算规范：mirrorRel(flatName(rel)) === rel
  const flatAll = rels.map(flatOf).filter((f) => f !== null);
  const dupFlats = new Set(dup.map((d) => d.flat));
  const isCanonical = (rel) => {
    const f = flatOf(rel);
    if (f === null) return false;
    try { return mirrorRel(f, flatAll) === rel; } catch (e) { return false; }
  };
  const nonIndex = [], loneIndex = [];
  for (const rel of rels) {
    if (isCanonical(rel)) continue;
    if (dupFlats.has(flatOf(rel))) continue; // 已由 dup 覆盖（删多余副本即可）
    if (rel.endsWith('/index.mw')) loneIndex.push(rel);
    else nonIndex.push(rel);
  }
  return { dup, nonIndex, loneIndex, byFlat };
}

// 每条布局问题的建议处置（供 CLI / 发布中止提示复用）
function layoutHints(layout) {
  const hints = [];
  for (const d of layout.dup) {
    const keep = d.rels.find((r) => r.endsWith('/index.mw')) || d.rels[0];
    for (const r of d.rels) {
      if (r === keep) continue;
      hints.push(`index冲突 ${d.flat}：content/${r} 与 content/${keep} 并存，请删除多余文件 content/${r}`);
    }
  }
  for (const r of layout.nonIndex) {
    hints.push(`父页面应存为 index.mw：content/${r} → content/${r.slice(0, -MW_EXT.length)}/index.mw`);
  }
  for (const r of layout.loneIndex) {
    hints.push(`无子页的 index.mw 应改回普通页：content/${r} → content/${r.replace(/\/index\.mw$/, MW_EXT)}`);
  }
  return hints;
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
// 重复扁平名只回写规范 index.mw，多余顶层文件不写入；处置见 dup/hints。
function flattenToFlat(flatDir, contentDir, opts = {}) {
  const { byFlat, layout } = contentNameMap(contentDir);
  const skip = opts.skip || new Set();
  let written = 0, unchanged = 0;
  for (const [flat, rel] of [...byFlat.entries()].sort()) {
    if (skip.has(flat)) continue;
    const src = path.join(contentDir, rel);
    const dst = path.join(flatDir, flat);
    if (fs.existsSync(dst) && sha1File(src) === sha1File(dst)) { unchanged++; continue; }
    written++;
    if (!opts.dryRun) copyIfChanged(src, dst);
  }
  return { written, unchanged, skipped: skip.size, dup: layout.dup, hints: layoutHints(layout) };
}

// 内容树相对路径 -> 对应扁平文件名的存在映射（用于内容侧遍历）
// 重复扁平名（如 <...>/X.mw 与 <...>/X/index.mw 并存）只取规范 index.mw，
// 其余顶层副本不再参与映射，由 contentLayoutConflicts/layoutHints 报告处置。
function contentNameMap(contentDir) {
  const { map, unmanaged } = scanContent(contentDir);
  const layout = contentLayoutConflicts(contentDir);
  const out = new Map(); // flat name -> rel
  const bad = [];
  for (const rel of [...map.keys()].sort()) {
    let flat;
    try { flat = flatName(rel); } catch (e) { bad.push(rel); continue; }
    const prev = out.get(flat);
    if (prev === undefined) { out.set(flat, rel); continue; }
    // 多个 content 页映射到同一扁平名：优先保留 index.mw（父页面规范存放）
    if (rel.endsWith('/index.mw') && !prev.endsWith('/index.mw')) out.set(flat, rel);
  }
  return { byFlat: out, layout, unmanaged, bad };
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
// 冲突 diff 生成：检测到冲突时为每个冲突页产出 unified diff 文件，
// 便于用任何文本编辑器（或差异／合并工具）查看并人工合并。
// 产物目录：<内容树同级>/.content-sync/conflicts（不在 content/ 也不在扁平仓库内，
// 不会混入页面同步）。
// ---------------------------------------------------------------------------
const CONFLICT_SUBDIR = path.join('.content-sync', 'conflicts');

// 冲突扁平文件名 -> 文件系统安全名（: / \ 会跨目录或引起混淆，替换为 _）
function safeConflictName(name) {
  return name.replace(/[:\\/]/g, '_');
}

// 默认冲突产物目录：内容树上一级目录下的 .content-sync/conflicts
function defaultConflictDir(contentDir) {
  return path.join(path.resolve(contentDir, '..'), CONFLICT_SUBDIR);
}

// 某页的冲突 diff 路径（无论文件当前是否存在，用于打印「改这里」路径）
function conflictDiffPath(contentDir, name, outDir) {
  return path.join(outDir || defaultConflictDir(contentDir), safeConflictName(name) + '.diff');
}

// 上次生成的冲突清单（回执）：记录每个 diff 文件的指纹，用于下次复检
const CONFLICT_STATE = 'state.json';

function readConflictState(dir) {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(dir, CONFLICT_STATE), 'utf8'));
    return { entries: Array.isArray(s.entries) ? s.entries : [] };
  } catch (e) { return { entries: [] }; }
}

function writeConflictState(dir, entries) {
  const f = path.join(dir, CONFLICT_STATE);
  if (!entries || !entries.length) { fs.rmSync(f, { force: true }); return; }
  fs.writeFileSync(f, JSON.stringify({ generatedAt: new Date().toISOString(), entries }, null, 2) + '\n');
}

// 为一批冲突扁平名生成 diff 产物：
//   <安全名>.diff   unified diff（a=扁平仓库/线上，b=content/ 本地编辑）；二进制图不生成
//   index.md        总览：真实路径与可直接运行的 code --diff 打开命令
//   state.json      回执：每个 diff 的指纹（下次复检「是否被人工修改过」）
// 已被人手修改过的 diff 不会被覆盖，只登记回执并在返回值里报出 keptEdited。
// 返回 { dir, files: [{ name, diff, flat, content }], keptEdited: [name] }
function writeConflictDiffs(conflictNames, flatDir, contentDir, outDir) {
  const dir = outDir || defaultConflictDir(contentDir);
  fs.mkdirSync(dir, { recursive: true });
  const prevBy = new Map(readConflictState(dir).entries.map((e) => [e.name, e]));
  const byFlat = contentNameMap(contentDir).byFlat;
  const files = [];
  const entries = [];
  const keptEdited = [];
  for (const name of conflictNames) {
    const flatP = path.join(flatDir, name);
    const rel = byFlat.get(name);
    const contentP = rel ? path.join(contentDir, rel) : null;
    const flatExists = fs.existsSync(flatP);
    const contentExists = !!contentP && fs.existsSync(contentP);
    // 二进制图冲突：文本 diff 无意义，只登记到 index.md，提示直接以一侧覆盖
    if (!isImage(name) && (flatExists || contentExists)) {
      const a = flatExists ? flatP : '/dev/null';
      const b = contentExists ? contentP : '/dev/null';
      const r = spawnSync('git', ['diff', '--no-index', '--', a, b], { encoding: 'utf8' });
      const diffText = ((r.stdout || '') + (r.stderr || '')).trim();
      if (diffText) {
        const diffP = path.join(dir, safeConflictName(name) + '.diff');
        const prev = prevBy.get(name);
        const nowSha = fs.existsSync(diffP) ? sha1File(diffP) : null;
        // 上次登记过指纹、且磁盘上已变样 ⇒ 人工改过：保留别人的版本，不覆盖
        const edited = !!(prev && prev.diffSha1 && nowSha && nowSha !== prev.diffSha1);
        if (edited) keptEdited.push(name);
        else fs.writeFileSync(diffP, diffText + '\n');
        files.push({ name, diff: diffP, flat: flatP, content: contentP });
        entries.push({
          name,
          diff: path.basename(diffP),
          // 人工改过时保留旧指纹，下次仍能识别出「这份是人工版」
          diffSha1: edited ? prev.diffSha1 : sha1File(diffP),
        });
        continue;
      }
    }
    files.push({ name, diff: null, flat: flatP, content: contentP }); // 二进制/无文本差异：仅登记
  }
  writeConflictState(dir, entries);
  // 总览 index.md
  const lines = [
    '# 内容同步冲突（' + new Date().toISOString() + '）',
    '',
    '以下页面在 content/（本地编辑工作区）与扁平仓库（线上来源）被**各自修改**，无法自动合并。',
    '每个 `*.diff` 均为 unified diff：`a/` = 扁平仓库版本，`b/` = content/ 版本。',
    '',
    '## 推荐：写进 git，用 VS Code 源代码管理面板 / 合并编辑器处理',    '',
    '```bash',
    'node bin/content-sync.js git-merge     # 把冲突写成真实 git 冲突（UU）',
    '```',
    '',
    '然后在 VS Code 的源代码管理面板 →「合并更改」→ 点文件上的「在合并编辑器中解决」',
    '（或设 `"git.mergeEditor": true` 后双击文件）→ Current = 扁平仓库/线上、Incoming = content/ 本地 →',
    '点「完成合并」。回来重跑同步命令（`flatten` / `publish` / `apply`）即自动写回并清掉冲突条目；',
    '放弃用 `node bin/content-sync.js git-merge --abort`。',
    '',
    '## 兜底（无 git / 非文本页）：用文本编辑器改 .diff',
    '',
    '1. 打开该页对应的 `<页>.diff`（下面每节的 `diff :` 一行就是路径）；',
    '2. **整份替换**成该页的**最终正文**——不要保留 `diff --git` / `---` / `+++` / `@@` 这些行，',
    '   也不要把 `-`、`+` 前缀留在正文里；',
    '3. 保存，然后**重跑刚才那条命令**（`flatten` / `mirror` / `publish` / `apply`）：',
    '   工具发现 diff 被改过 → 复检（不会产生新冲突才写）→ 写回两侧 → 继续执行。',
    '   （只想先看看能不能合并，就跑 `apply`：它只复检写回，不跑同步。）',
    '',
    '写回前的校验（不通过就拒绝并回滚，原文件一字不动）：空文件 / 残留冲突标记（`<<<<<<<` 等）/',
    '内容看着仍是 `@@` diff 结构 / 写回会引入原来冲突之外的新冲突。已解决的 diff 归档为 `<页>.diff.done`。',
    '',
    '## 只采用某一侧（不用改 diff）',
    '',
    '- 保留 **content/**（本地意图）：把扁平仓库那个文件改成与 content/ 一致；',
    '- 保留**扁平仓库**（线上最新）：把 content/ 那个文件改成与扁平仓库一致；',
    '- 或 `node bin/content-sync.js resolve`，逐项输 `f`（扁平→内容）/ `c`（内容→扁平）。',
    '',
    '## 兜底：想左右对照两份原文',
    '',
    '- 装了 VS Code：`code --diff "<扁平文件>" "<内容文件>"`（也可用任何差异／合并工具）；',
    '- 没装：用编辑器分别打开下面每节的 `扁平` / `内容` 两个路径即可。',
    '',
  ];
  for (const f of files) {
    lines.push('## ' + f.name);
    lines.push('- diff : ' + (f.diff ? '`' + f.diff + '`' : '（二进制，无法生成文本 diff，请直接以一侧覆盖）'));
    lines.push('- 扁平 : `' + f.flat + '`');
    lines.push('- 内容 : `' + (f.content || '（content/ 无此页，属删除类冲突）') + '`');
    lines.push('- 对照 : `code --diff "' + f.flat + '" "' + (f.content || '/dev/null') + '"`（可选，非必需）');
    lines.push('');
  }
  fs.writeFileSync(path.join(dir, 'index.md'), lines.join('\n'));
  return { dir, files, keptEdited };
}

// ---------------------------------------------------------------------------
// 发布：执行内容树 -> 扁平（含删除）；有冲突返回 false
// ---------------------------------------------------------------------------
function applyPublish(flatDir, contentDir, repo, opts = {}) {
  const layout = contentLayoutConflicts(contentDir);
  if (layout.dup.length) {
    // index 冲突会令回写读到“错误那份”文件，属内容树自身缺陷：直接中止，让用户先清理
    return {
      ok: false, conflict: [], conflictDir: null, conflictDiffs: [],
      indexConflicts: layout.dup, indexConflictHints: layoutHints(layout),
    };
  }
  const a = analyzePublish(flatDir, contentDir, repo);
  if (a.conflict.length) {
    // 冲突时默认自动生成 diff 供差异编辑器查看/合并（可用 opts.writeConflicts=false 关闭）
    let artifacts = null;
    if (opts.writeConflicts !== false) {
      artifacts = writeConflictDiffs(a.conflict, flatDir, contentDir, opts.conflictDir);
    }
    return {
      ok: false, conflict: a.conflict,
      conflictDir: artifacts && artifacts.dir,
      conflictDiffs: artifacts && artifacts.files,
    };
  }
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
// resolve：交互式解决冲突（打开差异编辑器 + 命令行同步推进）
// 逐个冲突自动用 `code --diff 扁平 内容` 打开 VS Code 差异编辑器，脚本停在命令行
// 等你：把两侧改成一致（保存即可）后自动进入下一项；也可直接输入 f/c 由命令行
// 采用一侧，或 s 跳过 / q 退出。
// 更少指令的做法见下面「改过 diff 就自动合并」：直接用任何外部差异编辑器改
// .content-sync/conflicts/<页>.diff，保存后重跑同步命令即可。
// ---------------------------------------------------------------------------
// 本机可用编辑器（不假设 VS Code）：优先 $VISUAL / $EDITOR，其次常见命令
function pickEditor() {
  for (const k of ['VISUAL', 'EDITOR']) {
    const v = (process.env[k] || '').trim();
    if (v) return v;
  }
  for (const c of ['nano', 'vim', 'vi', 'notepad']) {
    const r = spawnSync(c, ['--version'], { stdio: 'ignore' });
    if (!r.error) return c;
  }
  return '';
}

// 版本检测（缓存）：本机是否有 VS Code 的 code 命令
let _codeCli = null;
function hasCodeCli() {
  if (_codeCli === null) {
    const r = spawnSync('code', ['--version'], { stdio: 'ignore' });
    _codeCli = !r.error && r.status === 0;
  }
  return _codeCli;
}

// 打印「怎么改这个冲突」——一律不假设 VS Code：文本编辑器路径 / 可选对照命令
// 处于 git 合并（unmerged）时，用 index 的 stage2/stage3 取「原始两侧」，
// 而不是带 <<<<<<< 标记的工作树文件（避免把标记复制来复制去）
function gitStageContent(repo, name, stage) {
  const r = spawnSync('git', ['show', `:${stage}:${name}`], { cwd: repo });
  return r.status === 0 ? r.stdout : null;
}

function gitMergeSides(repo, name) {
  if (!listUnmergedPaths(repo).includes(name)) return null;
  return { ours: gitStageContent(repo, name, 2), theirs: gitStageContent(repo, name, 3) };
}

function resolveGitMergeTo(repo, name, side, flatDir, contentDir) {
  const info = gitMergeSides(repo, name);
  if (!info) return false;
  const buf = side === 'ours' ? info.ours : info.theirs;
  if (!buf) return false;
  writeIfChanged(buf, path.join(flatDir, name));                 // 工作树去掉冲突标记
  const rel = contentNameMap(contentDir).byFlat.get(name);
  if (rel) writeIfChanged(buf, path.join(contentDir, rel));      // 另一侧也对齐
  spawnSync('git', ['add', '--', name], { cwd: repo });          // 标记已解决
  fs.rmSync(gitMergeBackup(contentDir, name), { force: true });
  const st = readGitMergeState(contentDir);
  writeGitMergeState(contentDir, st.entries.filter((e) => e.name !== name));
  return true;
}

function printEditHints(flatP, contentP, diffP) {
  const ed = pickEditor();
  if (diffP) {
    console.log('  改这里（记事本 / nano / vim 均可）：' + diffP);
    console.log('    整份替换成该页最终正文（别留 -、+、@@ 这些行），保存后重跑本命令即自动写回两侧');
  }
  const side = contentP && fs.existsSync(contentP) ? contentP : flatP;
  console.log('  或直接编辑两侧文件（改到一致即自动放行）：' + side);
  if (ed) console.log('    例如：' + ed + ' "' + (diffP || side) + '"');
  if (hasCodeCli()) console.log('  左右对照（可选，VS Code）：code --diff "' + flatP + '" "' + (contentP || '/dev/null') + '"');
}

function openCodeDiff(flatP, contentP) {
  if (!hasCodeCli()) return;                  // 没有 code 就只留上面的文字指引，不自动启动别的编辑器
  try {
    const p = spawn('code', ['--diff', flatP, contentP || '/dev/null'],
      { detached: true, stdio: 'ignore' });
    p.on('error', () => { /* 已打印通用指引，忽略 */ });
    p.unref();
  } catch (e) { /* ignore */ }
}

function writeIfChanged(data, file) {
  const next = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (fs.existsSync(file) && fs.readFileSync(file).equals(next)) return false;
  fs.writeFileSync(file, next);
  return true;
}

function resolveConflictsInteractive(flatDir, contentDir, repo) {
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const pending = [];                       // 用户输入行队列（非阻塞，边等文件变化边收按键）
  rl.on('line', (l) => pending.push(String(l).trim().toLowerCase()));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  (async () => {
    const byFlat = contentNameMap(contentDir).byFlat;
    let a = analyzePublish(flatDir, contentDir, repo);
    let todo = [...a.conflict];
    if (!todo.length) {
      console.log('✅ 无冲突：内容树与扁平仓库没有“两侧各自改同一页”，可直接 publish。');
      rl.close(); return;
    }
    console.log(`发现 ${todo.length} 个冲突：解决一个（VS Code 合并编辑器「完成合并」/ 两侧改一致）会**自动**进入下一项。`);
    console.log('也可以直接输入：f=采用扁平→内容  c=采用内容→扁平  s=跳过  q=退出。');
    const art = materializeConflicts(todo, flatDir, contentDir, { quiet: true });
    if (art) console.log(`冲突 diff 已写入：${art.dir}（总览 index.md）`);
    let i = 0;
    const wasUnmerged = new Set(listUnmergedPaths(repo));   // 已在 git 里冲突的页：解决后 `git diff -U` 会变空
    const consistentOf = (name, flatP, contentP) => {
      if (wasUnmerged.has(name)) return !listUnmergedPaths(repo).includes(name);
      if (!fs.existsSync(flatP)) return false;
      if (!contentP || !fs.existsSync(contentP)) return false; // 删除类：需人工
      return sha1File(flatP) === sha1File(contentP);
    };
    while (i < todo.length) {
      const name = todo[i];
      const flatP = path.join(flatDir, name);
      const rel = byFlat.get(name);
      const contentP = rel ? path.join(contentDir, rel) : null;
      const cExists = !!contentP && fs.existsSync(contentP);
      console.log('\n[' + (i + 1) + '/' + todo.length + '] ' + name);
      console.log('  扁平 : ' + flatP);
      console.log('  内容 : ' + (contentP || '（无：content/ 已删此页，删除类冲突）'));
      printEditHints(flatP, contentP, conflictDiffPath(contentDir, name));
      if (fs.existsSync(flatP) || cExists) openCodeDiff(flatP, contentP);
      console.log('  （把两侧改到一致会自动继续；f=采用扁平→内容  c=采用内容→扁平  s=跳过  q=退出）');
      let waitingShown = false;
      for (;;) {
        await sleep(300);
        if (consistentOf(name, flatP, contentP)) {
          if (wasUnmerged.has(name)) {
            finishGitMerges(flatDir, contentDir, repo, { quiet: true });   // 同步回 content/ 并清 unmerged
            console.log('  ✓ git 里已标记解决，进入下一项（结果已同步回 content/）');
          } else {
            console.log('  ✓ 两侧已一致，进入下一项');
          }
          i++; break;
        }
        const ans = pending.shift();
        if (ans === undefined) {
          if (!waitingShown) { console.log('  …等待编辑中（也可以直接输入 f/c/s/q）'); waitingShown = true; }
          continue;
        }
        if (ans === '' || ans === 'ok' || ans === 'y') {
          console.log('  ⚠️ 还没解决：在 VS Code 合并编辑器里点「完成合并」会自动继续；或输入 f/c 直接采用一侧。');
          continue;
        }
        if (ans === 'f') {
          // 若该页处于 git 合并中，以 index 的「扁平侧（ours）」为准，并清掉冲突标记
          if (resolveGitMergeTo(repo, name, 'ours', flatDir, contentDir)) {
            console.log('  ✔ 已采用扁平侧 → content/（并清除 git 冲突标记）');
            i++; break;
          }
          if (fs.existsSync(flatP) && contentP && fs.existsSync(contentP)) {
            copyIfChanged(flatP, contentP);
            console.log('  ✔ 已采用扁平侧 → content/（' + (rel || '') + '）');
          } else if (fs.existsSync(flatP) && !cExists) {
            const rel2 = mirrorRel(name, listFlat(flatDir).mw);
            copyIfChanged(flatP, path.join(contentDir, rel2));
            console.log('  ✔ 已在 content/ 恢复（复活）该页：' + rel2);
          } else {
            console.log('  ⚠️ 扁平侧不存在，无法采用。');
          }
          continue;
        }
        if (ans === 'c') {
          if (resolveGitMergeTo(repo, name, 'theirs', flatDir, contentDir)) {
            console.log('  ✔ 已采用 content/ → 扁平仓库（并清除 git 冲突标记）');
            i++; break;
          }
          if (cExists) {
            copyIfChanged(contentP, flatP);
            console.log('  ✔ 已采用 content/ → 扁平仓库');
          } else {
            console.log('  ⚠️ content/ 无此页，无法“采用内容”。如需删除请手动处理（或跳过 s）。');
          }
          continue;
        }
        if (ans === 's') { console.log('  已跳过（保留冲突）。'); i++; break; }
        if (ans === 'q') { console.log('  退出。'); rl.close(); return; }
        console.log('  未知输入（直接编辑文件到一致会自动继续；f=扁平→内容 / c=内容→扁平 / s / q）');
      }
    }
    a = analyzePublish(flatDir, contentDir, repo);
    console.log('');
    if (a.conflict.length) {
      console.log(`⚠️ 仍剩 ${a.conflict.length} 个冲突：`, a.conflict);
      console.log('   可再运行 node git-mediawiki-tools/bin/content-sync.js resolve 继续解决。');
    } else {
      console.log('✅ 冲突已全部解决！可直接运行 node publish.js "说明" 发布。');
    }
    rl.close();
  })();
}

// ---------------------------------------------------------------------------
// 「会被覆盖」预检
// mirror / flatten 都是「整体以某一侧为准」的单向覆盖，这里先算出哪些文件会被改写：
//   analyzeMirror ：mirror 把【扁平仓库】写进 content/ —— content 侧有本地改动就会被回退
//   analyzeFlatten：flatten 把【内容树】写进扁平仓库 —— 扁平侧有未提交改动就会被覆盖
// 供 CLI 打印警告并在未加 --force 时中止（避免静默覆盖）。
// ---------------------------------------------------------------------------
const OVERWRITE_LABEL = {
  'content-dirty': 'content/ 侧本地改动会被回退',
  'both-changed': '两侧各自改（冲突）',
  'untracked': 'HEAD 里无此页，无法判断哪侧更新',
  'flat-dirty': '扁平仓库有未提交改动，会被覆盖',
};

// 该文件相对 HEAD 的改动情况：false=与 HEAD 相同；true=改过；'new'=HEAD 里没有
function localEdited(repo, name, currentSha) {
  const head = sha1Head(repo, name);
  if (head === null) return 'new';
  return head === currentSha ? false : true;
}

// mirror 将覆盖 content/ 的文件清单
function analyzeMirror(flatDir, contentDir) {
  const { byFlat } = contentNameMap(contentDir);
  const flat = listFlat(flatDir);
  const names = flat.mw.concat(flat.images).sort();
  const overwrite = [];
  let create = 0, update = 0, unchanged = 0;
  for (const name of names) {
    const fPath = path.join(flatDir, name);
    const rel = byFlat.get(name);
    const cPath = rel ? path.join(contentDir, rel) : null;
    if (!cPath || !fs.existsSync(cPath)) { create++; continue; }
    const F = sha1File(fPath);
    const C = sha1File(cPath);
    if (F === C) { unchanged++; continue; }
    update++;
    const cEdited = localEdited(flatDir, name, C);
    if (cEdited === false) continue;              // content 侧没动过 → 只是把扁平侧更新拉下来，安全
    const fEdited = localEdited(flatDir, name, F);
    let kind;
    if (fEdited === true || fEdited === 'new') kind = 'both-changed';
    else if (cEdited === 'new') kind = 'untracked';
    else kind = 'content-dirty';
    overwrite.push({ name, rel, kind });
  }
  return { create, update, unchanged, overwrite };
}

// flatten 将覆盖扁平仓库的文件清单（扁平侧有未提交改动 / 未跟踪新增）
function analyzeFlatten(flatDir, contentDir, repo) {
  const { byFlat } = contentNameMap(contentDir);
  const dirty = gitDirty(repo || flatDir);
  const overwrite = [];
  for (const [flat, rel] of [...byFlat.entries()].sort()) {
    const cPath = path.join(contentDir, rel);
    const fPath = path.join(flatDir, flat);
    if (!fs.existsSync(cPath) || !fs.existsSync(fPath)) continue;   // 新建不算覆盖
    if (sha1File(cPath) === sha1File(fPath)) continue;
    if (dirty.has(flat)) overwrite.push({ name: flat, rel, kind: 'flat-dirty' });
  }
  return { overwrite };
}

// 打印覆盖警告（并**把冲突写进 git / 生成兜底 diff**）；返回 true 表示“需要 --force 才能继续”
// opts.side：--force 时优先采用哪一侧（mirror 用 'ours'=扁平、flatten 用 'theirs'=content）
function warnOverwrite(title, overwrite, force, flatDir, contentDir, opts = {}) {
  if (!overwrite.length) return false;
  console.log(`⚠️ ${title}，会覆盖 ${overwrite.length} 处：`);
  for (const o of overwrite.slice(0, 10)) {
    console.log(`   - ${o.name}（${OVERWRITE_LABEL[o.kind] || o.kind}）`);
  }
  if (overwrite.length > 10) console.log(`   … 其余 ${overwrite.length - 10} 处`);
  materializeConflicts(overwrite.map((o) => o.name), flatDir, contentDir);
  if (force) {
    // --force 意味着「以某一侧为准」：把已在 git 里冲突的页面按该侧采用（否则会把 <<<<<<< 标记复制过去）
    const pendingGit = [...new Set([...readGitMergeState(contentDir).entries.map((e) => e.name),
      ...listUnmergedPaths(flatDir)])];
    const side = opts.side === 'theirs' ? 'theirs' : 'ours';
    let n = 0;
    for (const name of pendingGit) if (resolveGitMergeTo(flatDir, name, side, flatDir, contentDir)) n++;
    if (n) console.log(`   （--force：${n} 个 git 冲突按「${side === 'ours' ? '扁平/线上' : 'content/'}」采用并清掉）`);
  }
  if (!force) {
    console.log('   处理：在 VS Code 里把冲突解决（源代码管理 →「合并更改」→ 合并编辑器 →「完成合并」），');
    console.log('   然后重跑本命令即自动写回 content/ 并清掉冲突条目；也可 node content-sync.js resolve 逐项选一侧。');
    console.log('   确认要放弃这些改动才加 --force。');
    return true;
  }
  console.log('   （--force：按上述覆盖继续）');
  return false;
}

// 统一的「冲突写进 git」入口：凡是检测到冲突的地方都调它。
//   主产物流向：把冲突写成真实 git 冲突（UU）→ VS Code 源代码管理 → 内置合并编辑器
//   兼容产物：<内容树同级>/.content-sync/conflicts/<页>.diff + index.md（无 git / 非文本页的兜底）
function materializeConflicts(names, flatDir, contentDir, opts = {}) {
  if (!names || !names.length) return null;
  let git = { created: [], skipped: [] };
  if (opts.git !== false) {
    try { git = makeGitMergeConflicts(flatDir, contentDir, flatDir); }
    catch (e) { git = { created: [], skipped: [{ name: '(全部)', why: e.message }] }; }
  }
  const art = writeConflictDiffs(names, flatDir, contentDir, opts.outDir);
  if (opts.quiet) return Object.assign(art, { git });
  const maxList = opts.maxList === undefined ? 3 : opts.maxList;
  if (git.created.length) {
    console.log(`⚠️ 已把 ${git.created.length} 个冲突写进 git（扁平仓库 index，状态 UU）：`);
    git.created.slice(0, maxList).forEach((n) => console.log('   - ' + n));
    if (git.created.length > maxList) console.log(`   … 其余 ${git.created.length - maxList} 个`);
    console.log('   → VS Code 源代码管理 →「合并更改」→「在合并编辑器中解决」' +
      (hasCodeCli() ? '（或此处直接：code .）' : '') + '，合并后点「完成合并」；');
    console.log('   → 回终端重跑本命令（或 content-sync.js apply）：自动写回 content/ 并清掉冲突条目。');
    console.log('   （放弃：node bin/content-sync.js git-merge --abort）');
  }
  if (git.skipped.length) {
    console.log(`   其余 ${git.skipped.length} 个无法三方合并（二进制 / 缺一侧）：用 resolve 选一侧，或改下面的兜底 diff`);
  }
  console.log(`   文本兜底 diff：${art.dir}（总览 ${path.join(art.dir, 'index.md')}）`);
  if (art.keptEdited && art.keptEdited.length) {
    console.log(`   注意 : ${art.keptEdited.join('、')} 的 .diff 已被你修改过，本次未覆盖`);
  }
  return art;
}

// ---------------------------------------------------------------------------
// 「改过 diff 就自动合并」：上次生成的冲突 diff 被人工修改（用任何外部差异编辑器
// 或直接编辑保存）后，重跑同步命令时先复检：
//   1) 把改后的 diff 内容当作该页**最终正文**；
//   2) 校验：非空、文本、无冲突标记、不再像未处理的 diff；
//   3) 写回两侧（扁平仓库 + content/）后重新盘点冲突，必须
//      「不出现原来冲突之外的新冲突」，否则回滚、保持原样；
//   4) 通过后本次同步命令继续执行（不再要求 --force）。
// 两侧已被人手改到一致、或 diff 已被删掉，也一并复检放行。
// ---------------------------------------------------------------------------
const MERGE_MARKER_RE = /^(<{7}|={7}|>{7})/m;
const RAW_DIFF_RE = /^(diff --git |--- a\/|\+\+\+ b\/|@@ )/m;

// 当前所有「会被覆盖/冲突」的文件名集合（跨 publish/mirror/flatten 三种视角）
function conflictInventory(flatDir, contentDir, repo) {
  const names = new Set();
  for (const n of analyzePublish(flatDir, contentDir, repo).conflict) names.add(n);
  for (const o of analyzeMirror(flatDir, contentDir).overwrite) names.add(o.name);
  for (const o of analyzeFlatten(flatDir, contentDir, repo).overwrite) names.add(o.name);
  const layout = contentLayoutConflicts(contentDir);
  for (const d of layout.dup) names.add('布局:' + d.flat);
  for (const r of layout.nonIndex.concat(layout.loneIndex)) names.add('布局:' + r);
  return names;
}

// 校验人工结果能否安全写回；返回 null 表示通过，否则返回拒绝原因
function mergeResultProblem(text) {
  if (/^\s*$/.test(text)) return '文件是空的（如确实要清空该页，请写入一个换行，或用 resolve 显式选一侧）';
  if (text.indexOf('\u0000') !== -1) return '内容含 NUL 字节（二进制），无法写回文本页';
  if (MERGE_MARKER_RE.test(text)) return '还留有冲突标记（<<<<<<< / ======= / >>>>>>>），合并尚未完成';
  if (RAW_DIFF_RE.test(text)) return '内容仍是未处理的 diff（含 @@ 或 --- a/ 结构），请写入合并后的页面正文';
  return null;
}

// 把最终正文写回两侧，返回快照（用于回滚）
function writeMergedToBothSides(name, text, flatDir, contentDir) {
  const rel = contentNameMap(contentDir).byFlat.get(name);
  const targets = [path.join(flatDir, name)];
  if (rel) targets.push(path.join(contentDir, rel));
  const snapshot = [];
  for (const p of targets) {
    const had = fs.existsSync(p);
    snapshot.push({ p, had, data: had ? fs.readFileSync(p) : null });
    writeIfChanged(text, p);
  }
  return snapshot;
}

function restoreSnapshot(snapshot) {
  for (const s of snapshot) {
    if (s.had) fs.writeFileSync(s.p, s.data);
    else fs.rmSync(s.p, { force: true });
  }
}

// 把已解决的冲突 diff 归档（保留内容供追溯，但不再参与复检）
function archiveConflictDiff(diffP) {
  if (!diffP || !fs.existsSync(diffP)) return null;
  const done = diffP + '.done';
  try { fs.renameSync(diffP, done); return done; } catch (e) { return null; }
}

// 复检上次的冲突回执：diff 被改过 → 写回两侧；返回各分类结果
function autoApplyEditedDiffs(flatDir, contentDir, repo, opts = {}) {
  const quiet = !!opts.quiet;
  const dir = opts.outDir || defaultConflictDir(contentDir);
  const before = conflictInventory(flatDir, contentDir, repo);
  const res = { dir, applied: [], failed: [], resolved: [], pending: [] };
  const entries = readConflictState(dir).entries;
  if (!entries.length) return res;

  const kept = [];
  for (const e of entries) {
    const flatP = path.join(flatDir, e.name);
    const rel = contentNameMap(contentDir).byFlat.get(e.name);
    const contentP = rel ? path.join(contentDir, rel) : null;
    const flatSha = fs.existsSync(flatP) ? sha1File(flatP) : null;
    const contentSha = contentP && fs.existsSync(contentP) ? sha1File(contentP) : null;

    if (flatSha !== null && flatSha === contentSha) {   // 复检：两侧已无差异
      archiveConflictDiff(e.diff ? path.join(dir, e.diff) : null);
      res.resolved.push(e.name); continue;
    }
    const diffP = e.diff ? path.join(dir, e.diff) : null;
    if (!diffP || !fs.existsSync(diffP)) { res.pending.push(e.name); kept.push(e); continue; }
    if (!e.diffSha1 || sha1File(diffP) === e.diffSha1) { res.pending.push(e.name); kept.push(e); continue; }

    // diff 被人工改过 → 当成本页最终正文
    const text = fs.readFileSync(diffP, 'utf8');
    const why = mergeResultProblem(text);
    if (why) { res.failed.push({ name: e.name, why }); kept.push(e); continue; }
    const snapshot = writeMergedToBothSides(e.name, text, flatDir, contentDir);
    const added = [...conflictInventory(flatDir, contentDir, repo)].filter((n) => !before.has(n));
    if (added.length) {
      restoreSnapshot(snapshot);   // 出现原来冲突之外的新冲突 → 回滚，绝不写坏
      res.failed.push({ name: e.name, why: `写回会产生新冲突：${added.join('、')}（已回滚）` });
      kept.push(e); continue;
    }
    res.applied.push({ name: e.name, flat: flatP, content: contentP, done: archiveConflictDiff(diffP) });
  }
  writeConflictState(dir, kept);   // 已解决/已应用的条目出账，剩下的留待下次

  if (!quiet) {
    if (res.applied.length) {
      console.log(`✏️ 检测到 ${res.applied.length} 个冲突 diff 被人工修改过：已复检并写回两侧`);
      for (const a of res.applied) {
        console.log(`   ✔ ${a.name} → 扁平仓库 + ${a.content ? 'content/' : '（content/ 无此页）'} 已一致`
          + (a.done ? `（diff 归档为 ${path.basename(a.done)}）` : ''));
      }
    }
    if (res.resolved.length) console.log(`✅ ${res.resolved.length} 个冲突已无差异（两侧一致）：${res.resolved.join('、')}`);
    if (res.failed.length) {
      console.log('⚠️ 以下人工结果未被采用（原文件保持不动）：');
      for (const f of res.failed) console.log(`   ✗ ${f.name}：${f.why}`);
      console.log(`   修正后可重跑本命令；或换用：node content-sync.js resolve（交互选择一侧）`);
    }
    if (res.pending.length) {
      console.log(`⏳ 仍有 ${res.pending.length} 个冲突未解决：${res.pending.join('、')}`);
      console.log('   在 VS Code 源代码管理 →「合并更改」→ 合并编辑器解决（git 合并），或直接改冲突 diff；');
      console.log(`   解决后重跑本命令：node content-sync.js apply`);
    }
  }
  return res;
}

// ---------------------------------------------------------------------------
// 把冲突「写进 git」：在扁平仓库 index 里造出真实的三方冲突条目
//   stage1 = HEAD 版本（共同祖先）
//   stage2 = 扁平仓库工作树（线上最新，ours/Current）
//   stage3 = content/ 本地编辑（theirs/Incoming）
// 工作树文件写成带 <<<<<<< 标记的版本 —— VS Code 源代码管理面板会把它列进
// 「合并更改」，可直接用内置合并编辑器（Resolve in Merge Editor / 打开合并编辑器）处理。
// 只处理「两侧都有文件」的文本页；删除类冲突与二进制图片跳过（仍走 diff 流程）。
// 备份扁平侧原始内容，便于 --abort 完整还原。
// ---------------------------------------------------------------------------
const GIT_MERGE_SUBDIR = path.join(CONFLICT_SUBDIR, 'git-merge');

function gitMergeDir(contentDir) {
  return path.join(path.resolve(contentDir, '..'), GIT_MERGE_SUBDIR);
}

function gitMergeBackup(contentDir, name) {
  return path.join(gitMergeDir(contentDir), safeConflictName(name) + '.ours');
}

function readGitMergeState(contentDir) {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(gitMergeDir(contentDir), 'index.json'), 'utf8'));
    return { entries: Array.isArray(s.entries) ? s.entries : [] };
  } catch (e) { return { entries: [] }; }
}

function writeGitMergeState(contentDir, entries) {
  const dir = gitMergeDir(contentDir);
  const f = path.join(dir, 'index.json');
  if (!entries.length) { fs.rmSync(f, { force: true }); return; }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ createdAt: new Date().toISOString(), entries }, null, 2) + '\n');
}

// 本次需要人工合并的页面名（publish 冲突 + mirror/flatten 会被覆盖）
function conflictNames(flatDir, contentDir, repo) {
  const names = new Set();
  for (const n of analyzePublish(flatDir, contentDir, repo).conflict) names.add(n);
  for (const o of analyzeMirror(flatDir, contentDir).overwrite) names.add(o.name);
  for (const o of analyzeFlatten(flatDir, contentDir, repo).overwrite) names.add(o.name);
  return [...names].sort();
}

// git index 里处于未解决（unmerged）状态的路径
function listUnmergedPaths(repo) {
  const r = spawnSync('git', ['diff', '--name-only', '--diff-filter=U'], { cwd: repo, encoding: 'utf8' });
  return (r.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
}

function gitHashObject(repo, buf) {
  const r = spawnSync('git', ['hash-object', '-w', '--stdin'], { cwd: repo, input: buf });
  if (r.status !== 0) throw new Error('git hash-object 失败：' + String(r.stderr || '').trim());
  return String(r.stdout).trim();
}

function gitShowBlob(repo, spec) {
  const r = spawnSync('git', ['show', spec], { cwd: repo });
  return r.status === 0 ? r.stdout : null;
}

function makeGitMergeConflicts(flatDir, contentDir, repo) {
  const byFlat = contentNameMap(contentDir).byFlat;
  const created = [], skipped = [];
  const state = readGitMergeState(contentDir);
  const kept = new Map(state.entries.map((e) => [e.name, e]));
  const already = new Set([...kept.keys(), ...listUnmergedPaths(repo)]);   // 已在 git 合并中
  for (const name of conflictNames(flatDir, contentDir, repo)) {
    const flatP = path.join(flatDir, name);
    const rel = byFlat.get(name);
    const contentP = rel ? path.join(contentDir, rel) : null;
    // 已在合并 / 已写过的不重复动它（否则会覆盖你正在合并编辑器里做的解决结果）
    if (already.has(name)) { continue; }
    if (isImage(name)) { skipped.push({ name, why: '二进制图片' }); continue; }
    if (!contentP || !fs.existsSync(flatP) || !fs.existsSync(contentP)) {
      skipped.push({ name, why: '缺一侧（删除 / 新增类冲突）' });
      continue;
    }
    const ours = fs.readFileSync(flatP);
    const theirs = fs.readFileSync(contentP);
    const base = gitShowBlob(repo, 'HEAD:' + name) || Buffer.alloc(0);
    let info;
    try {
      const [b1, b2, b3] = [base, ours, theirs].map((b) => gitHashObject(repo, b));
      // 第一行先把原有的 stage-0 条目删掉（否则 git 认为已解决，只显示 modified）；
      // 后三行写入 stages 1/2/3 → `git status` 显示 UU（both modified）
      info = `0 ${'0'.repeat(40)}\t${name}\n`
        + `100644 ${b1} 1\t${name}\n100644 ${b2} 2\t${name}\n100644 ${b3} 3\t${name}\n`;
    } catch (e) {
      skipped.push({ name, why: e.message });
      continue;
    }
    const up = spawnSync('git', ['update-index', '--index-info'], { cwd: repo, input: info, encoding: 'utf8' });
    if (up.status !== 0) {
      skipped.push({ name, why: 'git update-index 失败：' + String(up.stderr || '').trim() });
      continue;
    }
    fs.mkdirSync(gitMergeDir(contentDir), { recursive: true });
    fs.writeFileSync(gitMergeBackup(contentDir, name), ours);      // 备份扁平侧原内容（供 --abort）
    // 工作树写成带冲突标记的版本（让 VS Code 与 git 都认为「未解决」）
    spawnSync('git', ['checkout', '--conflict=merge', '--', name], { cwd: repo, encoding: 'utf8' });
    let marked = fs.existsSync(flatP) ? fs.readFileSync(flatP, 'utf8') : '';
    if (MERGE_MARKER_RE.test(marked)) {
      // 把 git 默认的 ours/theirs 标签换成看得懂的名字（标记本身不变，VS Code 仍能识别）
      fs.writeFileSync(flatP, marked
        .replace(/^<{7} ours$/m, '<<<<<<< 扁平仓库/线上（ours）')
        .replace(/^>{7} theirs$/m, '>>>>>>> content/本地编辑（theirs）'));
    } else {
      fs.writeFileSync(flatP,
        `<<<<<<< 扁平仓库/线上（ours）\n${ours}=======\n${theirs}>>>>>>> content/本地编辑（theirs）\n`);
    }
    kept.set(name, { name, backup: path.basename(gitMergeBackup(contentDir, name)), content: contentP });
    created.push(name);
  }
  writeGitMergeState(contentDir, [...kept.values()]);
  return { created, skipped };
}

// 收尾：把「已在工作树解决」（不再有冲突标记）的 git 合并冲突同步回 content/，
// 并清掉 index 里的 unmerged 条目（git add）——相当于 git 里的「标记为已解决」。
// 仍带标记的保留原样，交给调用方提示。
function finishGitMerges(flatDir, contentDir, repo, opts = {}) {
  const quiet = !!opts.quiet;
  const state = readGitMergeState(contentDir);
  const names = new Set([...state.entries.map((e) => e.name), ...listUnmergedPaths(repo)]);
  const res = { done: [], pending: [], skipped: [] };
  if (!names.size) return res;
  const byFlat = contentNameMap(contentDir).byFlat;
  const kept = new Map(state.entries.map((e) => [e.name, e]));
  for (const name of [...names].sort()) {
    const flatP = path.join(flatDir, name);
    if (!fs.existsSync(flatP)) { res.pending.push(name); continue; }
    const buf = fs.readFileSync(flatP);
    if (isImage(name) || buf.indexOf(0) !== -1) { res.skipped.push({ name, why: '二进制' }); res.pending.push(name); continue; }
    const text = buf.toString('utf8');
    if (MERGE_MARKER_RE.test(text)) { res.pending.push(name); continue; }   // 还没解决
    let rel = byFlat.get(name);
    if (!rel) { try { rel = mirrorRel(name, listFlat(flatDir).mw); } catch (e) { rel = null; } }
    let contentP = null;
    if (rel) { contentP = path.join(contentDir, rel); writeIfChanged(buf, contentP); }
    const add = spawnSync('git', ['add', '--', name], { cwd: repo, encoding: 'utf8' });
    if (add.status !== 0) {
      res.skipped.push({ name, why: 'git add 失败：' + String(add.stderr || '').trim() });
      res.pending.push(name); continue;
    }
    fs.rmSync(gitMergeBackup(contentDir, name), { force: true });
    kept.delete(name);
    res.done.push({ name, content: contentP });
  }
  writeGitMergeState(contentDir, [...kept.values()]);

  if (!quiet) {
    if (res.done.length) {
      console.log(`🧩 git 合并冲突已解决 ${res.done.length} 个：已同步回 content/ 并 git add`
        + `（VS Code 里：合并更改 → 暂存更改）`);
      for (const d of res.done) console.log(`   ✔ ${d.name} → ${d.content || '（content/ 未映射？）'}`);
    }
    if (res.pending.length) {
      console.log(`⏳ git 合并冲突仍有 ${res.pending.length} 个未解决（工作树还带 <<<<<<< 标记）：${res.pending.join('、')}`);
      console.log('   在 VS Code 源代码管理面板 →「合并更改」→「在合并编辑器中解决」，点「完成合并」后重跑本命令；');
      console.log('   放弃这次合并：node content-sync.js git-merge --abort');
    }
  }
  return res;
}

// 撤销：还原扁平侧原始内容，并清掉 index 里的 unmerged 条目
function abortGitMerges(flatDir, contentDir, repo) {
  const state = readGitMergeState(contentDir);
  const names = [...new Set([...state.entries.map((e) => e.name), ...listUnmergedPaths(repo)])].sort();
  const restored = [];
  for (const name of names) {
    const bak = gitMergeBackup(contentDir, name);
    if (fs.existsSync(bak)) { fs.writeFileSync(path.join(flatDir, name), fs.readFileSync(bak)); fs.rmSync(bak, { force: true }); }
    spawnSync('git', ['reset', '-q', '--', name], { cwd: repo, encoding: 'utf8' });
    restored.push(name);
  }
  writeGitMergeState(contentDir, []);
  return { restored };
}

// ---------------------------------------------------------------------------
// 命令行入口（与 content_manage.py 对齐的轻量实现）
// ---------------------------------------------------------------------------
function cli() {
  const argv = process.argv.slice(2);
  // 找出命令（忽略 --opt 及其取值），兼容选项在命令前/后
  const known = ['mirror', 'flatten', 'status', 'check', 'dedupe-images', 'conflicts', 'resolve', 'apply', 'git-merge', 'diff'];
  let cmd = argv.find((a) => known.includes(a));
  cmd = cmd || argv[0];
  const optOf = (k) => {
    const i = argv.indexOf('--' + k);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : undefined;
  };
  const dry = argv.includes('--dry-run');
  const force = argv.includes('--force') || argv.includes('-f');
  const flatDir = optOf('flat') || cfg.wikiRepo;
  const contentDir = optOf('content') || cfg.contentDir;
  const repo = flatDir;

  // 会写文件的命令：先收尾「已经在 git / diff 里解决」的冲突，然后继续原命令
  //   1) git 原生冲突（git-merge 造出来的）：工作树已无 <<<<<<< 标记 → 同步回 content/ 并清 unmerged
  //   2) 冲突 diff 产物被人工改过 → 当成本页最终正文写回两侧
  let autoRes = null;
  if (['mirror', 'flatten', 'resolve', 'apply'].includes(cmd) && !dry) {
    finishGitMerges(flatDir, contentDir, repo);
    autoRes = autoApplyEditedDiffs(flatDir, contentDir, repo);
    finishGitMerges(flatDir, contentDir, repo, { quiet: true });   // diff 刚写回的结果也顺手收尾一次
  }

  if (cmd === 'mirror') {
    // 先预检：mirror 以扁平仓库为准，会回退 content/ 侧的本地改动
    if (!dry) {
      const pre = analyzeMirror(flatDir, contentDir);
      if (warnOverwrite('mirror 会把扁平仓库（线上）的文件写进 content/（以扁平为准）',
        pre.overwrite, force, flatDir, contentDir, { side: 'ours' })) process.exit(1);
    }
    const s = mirrorToContent(flatDir, contentDir, { dryRun: dry });
    console.log(`mirror: 新建 ${s.created}, 更新 ${s.updated}, 未变 ${s.unchanged}`
      + `, 图片去重 ${s.deduped}${dry ? '（dry-run）' : ''}`);
    const hints = layoutHints(contentLayoutConflicts(contentDir));
    if (hints.length) {
      console.log(`⚠️ content/ 布局/index 冲突 ${hints.length} 处（mirror 不删多余文件，请按提示清理）：`);
      hints.forEach((h) => console.log('   ' + h));
    }
  } else if (cmd === 'flatten') {
    // 先预检：flatten 以内容树为准，会覆盖扁平仓库的未提交改动
    if (!dry) {
      const pre = analyzeFlatten(flatDir, contentDir, repo);
      if (warnOverwrite('flatten 会把 content/ 写进扁平仓库（以内容树为准）',
        pre.overwrite, force, flatDir, contentDir, { side: 'theirs' })) process.exit(1);
    }
    const s = flattenToFlat(flatDir, contentDir, { dryRun: dry });
    const d = dry ? 0 : dedupeImages(flatDir, contentDir).linked;
    console.log(`flatten: 写入 ${s.written}, 未变 ${s.unchanged}, 图片去重 ${d}${dry ? '（dry-run）' : ''}`);
    if (s.hints.length) {
      console.log(`⚠️ content/ 布局/index 冲突 ${s.dup.length} 处（多余文件未回写）：`);
      s.hints.forEach((h) => console.log('   ' + h));
    }
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
    const hints = layoutHints(contentLayoutConflicts(contentDir));
    if (hints.length) {
      console.log(`⚠️ content/ 布局/index 冲突 ${hints.length} 处：`);
      hints.forEach((h) => console.log('   ' + h));
    }
    if (a.conflict.length) {
      const c = writeConflictDiffs(a.conflict, flatDir, contentDir);
      console.log(`  ⚠️ 已为 ${c.files.length} 个冲突生成 diff：${c.dir}`);
      console.log(`    总览: ${path.join(c.dir, 'index.md')}（已在 git 里标为 UU：VS Code 源代码管理 →「合并更改」→ 合并编辑器）`);
    }
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
    layoutHints(contentLayoutConflicts(contentDir)).forEach((h) => { console.log('内容树布局问题:', h); err++; });
    console.log(`check: ${mw.length} 页 + ${images.length} 图，${err ? '发现问题 ' + err + ' 处 ✗' : '往返一致 ✓'}`);
  } else if (cmd === 'diff') {
    const a = analyzePublish(flatDir, contentDir, repo);
    const byFlat = contentNameMap(contentDir).byFlat;
    const rows = [];
    const pushRow = (name, side) => {
      const fp = path.join(flatDir, name);
      const rel = byFlat.get(name);
      rows.push({ name, side, fp, cp: rel ? path.join(contentDir, rel) : null });
    };
    (a.flatten || []).forEach((n) => pushRow(n, '内容树→扁平(待回写)'));
    (a.refreshAfter || []).forEach((n) => pushRow(n, '扁平→内容树(待刷新)'));
    if (!rows.length) {
      console.log('无待同步差异：扁平仓库与 content/ 已一致。');
      if (a.conflict.length) {
        materializeConflicts(a.conflict, flatDir, contentDir);
        console.log(`   ${a.conflict.length} 个冲突需人工处理：已在 git 里标为 UU，VS Code 源代码管理 →「合并更改」→ 合并编辑器（或 content-sync.js resolve）`);
      }
      return;
    }
    console.log(`本地待同步差异 ${rows.length} 个（扁平 ↔ content/，不含冲突）：`);
    for (const r of rows) {
      console.log('\n  [' + r.side + '] ' + r.name);
      console.log('      扁平  : ' + r.fp);
      console.log('      内容  : ' + (r.cp || '（content/ 无此页）'));
      console.log('      查看  : 直接改这两份文件到一致（VS Code 里想对照可用 code --diff 或其它差异工具）');
      console.log('              ' + r.fp);
      console.log('              ' + (r.cp || '（content/ 无此页）'));
    }
    if (a.conflict.length) {
      console.log(`\n⚠️ 另有 ${a.conflict.length} 个冲突不属待同步：`);
      materializeConflicts(a.conflict, flatDir, contentDir);
      console.log('   先解决（VS Code 源代码管理 →「合并更改」→ 合并编辑器，或把两侧文件改成一致），再重跑本命令复检写回');
    }
  } else if (cmd === 'conflicts') {
    const a = analyzePublish(flatDir, contentDir, repo);
    if (!a.conflict.length) {
      console.log('无冲突：内容树与扁平仓库没有“两侧各自改同一页”的情况。');
    } else {
      console.log(`共 ${a.conflict.length} 个冲突：`);
      materializeConflicts(a.conflict, flatDir, contentDir, { maxList: 99 });
    }
  } else if (cmd === 'resolve') {
    resolveConflictsInteractive(flatDir, contentDir, repo);
  } else if (cmd === 'apply') {
    // 只做复检与写回，不跑同步：适合「我处理完了，先看看能不能合并」
    const r = autoRes || autoApplyEditedDiffs(flatDir, contentDir, repo);
    const left = r.pending.concat(r.failed.map((f) => f.name));
    if (!left.length) console.log('✅ 冲突均已解决：可继续 flatten / publish。');
    else {
      console.log(`⚠️ 仍有 ${left.length} 个冲突未解决：${left.join('、')}`);
      console.log('   在 VS Code 源代码管理 →「合并更改」→ 合并编辑器解决（还没写进 git 就先跑 git-merge）；');
      console.log('   也可改冲突 .diff（文本兜底）或 node content-sync.js resolve 选一侧，然后重跑本命令。');
      process.exit(1);
    }
  } else if (cmd === 'git-merge') {
    // 把冲突写进 git（VS Code 源代码管理面板 →「合并更改」→ 内置合并编辑器）
    if (argv.includes('--abort')) {
      const r = abortGitMerges(flatDir, contentDir, repo);
      if (!r.restored.length) console.log('没有进行中的 git 合并冲突（无需撤销）。');
      else {
        console.log(`↩️ 已撤销 ${r.restored.length} 个 git 合并冲突：扁平侧工作树内容已还原、index 已清理`);
        r.restored.forEach((n) => console.log('   - ' + n));
      }
    } else {
      const r = makeGitMergeConflicts(flatDir, contentDir, repo);
      if (!r.created.length) {
        console.log('没有可写入 git 的冲突（可能只剩删除类/二进制冲突，或已经写入过了）。');
      } else {
        console.log(`✅ 已把 ${r.created.length} 个冲突写进 git（扁平仓库 index，状态 UU）：`);
        r.created.forEach((n) => console.log('   - ' + n));
        console.log('');
        console.log('在 VS Code 里处理：源代码管理面板 →「合并更改」→ 点文件上的「在合并编辑器中解决」；');
        console.log('想直接进合并编辑器可设 `"git.mergeEditor": true`。合并后点「完成合并」。');
        console.log('然后重跑 flatten / publish：工具会把结果同步回 content/ 并自动清掉冲突条目。');
      }
      if (r.skipped.length) {
        console.log(`（${r.skipped.length} 个跳过：` + r.skipped.map((s) => `${s.name}（${s.why}）`).join('、') + '）');
        console.log('   这些仍按冲突 diff / 文本编辑处理：node content-sync.js conflicts');
      }
      if (listUnmergedPaths(repo).length) console.log('放弃这次合并：node content-sync.js git-merge --abort');
    }
  } else {
    console.log(`用法: node content-sync.js mirror|flatten|status|diff|check|conflicts|resolve|apply|git-merge|dedupe-images [--flat DIR] [--content DIR] [--dry-run] [--force]`);
  }
}

if (require.main === module) cli();

module.exports = {
  isImage, sha1File, copyIfChanged, dedupeImages,
  listFlat, scanContent, mirrorRel, flatName, splitFlatMw,
  gitDirty, gitTracked, sha1Head,
  mirrorToContent, flattenToFlat, contentNameMap, buildState,
  analyzePublish, applyPublish, refreshContentFromFlat, pendingLocalEdits,
  safeConflictName, defaultConflictDir, writeConflictDiffs, resolveConflictsInteractive,
  contentLayoutConflicts, layoutHints,
  analyzeMirror, analyzeFlatten, localEdited, OVERWRITE_LABEL, materializeConflicts,
  writeIfChanged, autoApplyEditedDiffs, conflictInventory, readConflictState, writeConflictState,
  makeGitMergeConflicts, finishGitMerges, abortGitMerges, listUnmergedPaths, conflictNames,
};
