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
 *   （unified diff）到 <内容树同级>/.content-sync/conflicts/，便于在 VS Code
 *   差异编辑器（code --diff 扁平文件 内容文件）中查看并人工合并。
 *   resolve 命令逐个用 code --diff 打开冲突并停在命令行等你编辑：两侧改到一致
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
// 便于在 VS Code 差异编辑器（code --diff 扁平文件 内容文件）中查看并人工合并。
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

// 为一批冲突扁平名生成 diff 产物：
//   <安全名>.diff   unified diff（a=扁平仓库/线上，b=content/ 本地编辑）；二进制图不生成
//   index.md        总览：真实路径与可直接运行的 code --diff 打开命令
// 返回 { dir, files: [{ name, diff, flat, content }] }
function writeConflictDiffs(conflictNames, flatDir, contentDir, outDir) {
  const dir = outDir || defaultConflictDir(contentDir);
  fs.mkdirSync(dir, { recursive: true });
  const byFlat = contentNameMap(contentDir).byFlat;
  const files = [];
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
        fs.writeFileSync(diffP, diffText + '\n');
        files.push({ name, diff: diffP, flat: flatP, content: contentP });
      }
    } else {
      files.push({ name, diff: null, flat: flatP, content: contentP }); // 二进制：仅登记
    }
  }
  // 总览 index.md
  const lines = [
    '# 内容同步冲突（' + new Date().toISOString() + '）',
    '',
    '以下页面在 content/（本地编辑工作区）与扁平仓库（线上来源）被**各自修改**，无法自动合并。',
    '每个 `*.diff` 均为 unified diff：`a/` = 扁平仓库版本，`b/` = content/ 版本。',
    '',
    '解决方式（任选其一，使两侧一致后重跑 content-sync / publish）：',
    '- 保留 **content/**（本地意图）：把扁平仓库文件改成与 content/ 一致；',
    '- 保留**扁平仓库**（线上最新）：把 content/ 文件改成与扁平仓库一致；',
    '- 或：`code --diff "<扁平文件>" "<内容文件>"` 打开 VS Code 差异编辑器手动合并。',
    '',
  ];
  for (const f of files) {
    lines.push('## ' + f.name);
    lines.push('- diff : ' + (f.diff ? '`' + f.diff + '`' : '（二进制，无法生成文本 diff，请直接以一侧覆盖）'));
    lines.push('- 扁平 : `' + f.flat + '`');
    lines.push('- 内容 : `' + (f.content || '（content/ 无此页，属删除类冲突）') + '`');
    lines.push('- 打开 : `code --diff "' + f.flat + '" "' + (f.content || '/dev/null') + '"`');
    lines.push('');
  }
  fs.writeFileSync(path.join(dir, 'index.md'), lines.join('\n'));
  return { dir, files };
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
// resolve：交互式可视化解决冲突（可视化编辑 + 命令行同步推进）
// 逐个冲突自动用 `code --diff 扁平 内容` 打开 VS Code 差异编辑器，脚本停在命令行
// 等你：把两侧改成一致（保存即可）后回车即自动进入下一项；也可直接输入 f/c 由
// 命令行采用一侧，或 s 跳过 / q 退出。
// ---------------------------------------------------------------------------
function openVsCodeDiff(flatP, contentP) {
  try {
    const p = spawn('code', ['--diff', flatP, contentP || '/dev/null'],
      { detached: true, stdio: 'ignore' });
    p.on('error', () => console.log('   （未找到 code 命令，请手动执行上方 code --diff 命令打开差异编辑器）'));
    p.unref();
  } catch (e) { /* ignore */ }
}

function resolveConflictsInteractive(flatDir, contentDir, repo) {
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((res) => rl.question(q, res));

  (async () => {
    const byFlat = contentNameMap(contentDir).byFlat;
    let a = analyzePublish(flatDir, contentDir, repo);
    let todo = [...a.conflict];
    if (!todo.length) {
      console.log('✅ 无冲突：内容树与扁平仓库没有“两侧各自改同一页”，可直接 publish。');
      rl.close(); return;
    }
    console.log(`发现 ${todo.length} 个冲突，逐个在 VS Code 差异编辑器解决（命令行同步推进）：`);
    console.log('提示：在差异编辑器把两侧改成一致并保存后回车；或直接输入 f/c 由命令行采用一侧。');
    let i = 0;
    const consistentOf = (flatP, contentP) => {
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
      console.log('  打开 : code --diff "' + flatP + '" "' + (contentP || '/dev/null') + '"');
      if (fs.existsSync(flatP) || cExists) openVsCodeDiff(flatP, contentP);
      for (;;) {
        const ok = consistentOf(flatP, contentP);
        const ans = (await ask(ok
          ? '  ✓ 两侧已一致，回车进入下一项 > '
          : '  [回车]检查是否已改一致  f=采用扁平→内容  c=采用内容→扁平  s=跳过  q=退出 > ')).trim().toLowerCase();
        if (!ans || ans === 'ok' || ans === 'y') {
          if (ok) { i++; break; }
          console.log('  ⚠️ 两侧还不一致：在差异编辑器改到一致并保存后回车；或输入 f/c 直接采用一侧。');
          continue;
        }
        if (ans === 'f') {
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
        console.log('  未知输入（回车 / f / c / s / q）。');
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

// 打印覆盖警告；返回 true 表示“需要 --force 才能继续”
function warnOverwrite(title, overwrite, force) {
  if (!overwrite.length) return false;
  console.log(`⚠️ ${title}，会覆盖 ${overwrite.length} 处：`);
  for (const o of overwrite.slice(0, 10)) {
    console.log(`   - ${o.name}（${OVERWRITE_LABEL[o.kind] || o.kind}）`);
  }
  if (overwrite.length > 10) console.log(`   … 其余 ${overwrite.length - 10} 处`);
  if (!force) {
    console.log('   确认要放弃这些改动请加 --force；先看差异：status / conflicts / diff');
    return true;
  }
  console.log('   （--force：按上述覆盖继续）');
  return false;
}

// ---------------------------------------------------------------------------
// 命令行入口（与 content_manage.py 对齐的轻量实现）
// ---------------------------------------------------------------------------
function cli() {
  const argv = process.argv.slice(2);
  // 找出命令（忽略 --opt 及其取值），兼容选项在命令前/后
  const known = ['mirror', 'flatten', 'status', 'check', 'dedupe-images', 'conflicts', 'resolve', 'diff'];
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

  if (cmd === 'mirror') {
    // 先预检：mirror 以扁平仓库为准，会回退 content/ 侧的本地改动
    if (!dry) {
      const pre = analyzeMirror(flatDir, contentDir);
      if (warnOverwrite('mirror 会把扁平仓库（线上）的文件写进 content/（以扁平为准）',
        pre.overwrite, force)) process.exit(1);
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
        pre.overwrite, force)) process.exit(1);
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
      console.log(`    总览: ${path.join(c.dir, 'index.md')}（可用 code --diff 逐对打开差异编辑器合并）`);
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
      if (a.conflict.length) console.log(`（另有 ${a.conflict.length} 个冲突需人工：node content-sync.js resolve）`);
      return;
    }
    console.log(`本地待同步差异 ${rows.length} 个（扁平 ↔ content/，不含冲突）：`);
    for (const r of rows) {
      console.log('\n  [' + r.side + '] ' + r.name);
      console.log('      扁平  : ' + r.fp);
      console.log('      内容  : ' + (r.cp || '（content/ 无此页）'));
      console.log('      查看  : code --diff "' + r.fp + '" "' + (r.cp || '/dev/null') + '"');
    }
    if (a.conflict.length) {
      console.log(`\n⚠️ 另有 ${a.conflict.length} 个冲突不属待同步，请先 node content-sync.js resolve 处理：`, a.conflict);
    }
  } else if (cmd === 'conflicts') {
    const a = analyzePublish(flatDir, contentDir, repo);
    if (!a.conflict.length) {
      console.log('无冲突：内容树与扁平仓库没有“两侧各自改同一页”的情况。');
    } else {
      const c = writeConflictDiffs(a.conflict, flatDir, contentDir);
      console.log(`共 ${a.conflict.length} 个冲突，已生成 diff 到：${c.dir}`);
      for (const f of c.files) {
        console.log('  ' + f.name);
        console.log('    diff : ' + (f.diff || '（二进制，无文本 diff）'));
        console.log('    打开 : code --diff "' + f.flat + '" "' + (f.content || '/dev/null') + '"');
      }
      console.log('总览: ' + path.join(c.dir, 'index.md'));
    }
  } else if (cmd === 'resolve') {
    resolveConflictsInteractive(flatDir, contentDir, repo);
  } else {
    console.log('用法: node content-sync.js mirror|flatten|status|diff|check|conflicts|resolve|dedupe-images [--flat DIR] [--content DIR] [--dry-run]');
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
  analyzeMirror, analyzeFlatten, localEdited, OVERWRITE_LABEL,
};
