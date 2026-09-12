#!/usr/bin/env node
/**
 * 发布脚本：提交本地修改并推送到 git-mediawiki 远程。
 * 推送顺序取 config.json 的 pushOrder（缺省只推主 remote；可在首位放同一 wiki 的快速镜像）。
 * 每个远程推送前各自做一次 sync（fetch + 采用线上新修订/变基）；推送失败时检查
 * 该站点是否在推送期间有新修订，如有则提示“该仓库有人上传/站端刚编辑”。
 *
 * 远程角色（config.json 的 remotes，缺省全部按 primary）：
 *   primary 主站      —— 主要推送的站点，必须成功
 *   accel   加速链接  —— 绑定某个源站（binds）的同一 wiki 端点；推送成功后即视为源站已上线，
 *                        不再单独推源站（只把修订号同步过去 + 对齐引用）；失败则回退推源站
 *   mirror  镜像站    —— 独立站点，各自有修订体系；推送后不会立即同步主站，需等其自身同步
 *
 * 用法: node publish.js [提交说明] [--yes]
 * 示例: node publish.js "更新首页模板"
 *   --yes / -y（或 MW_PUBLISH_YES=1）：跳过「待删除页面」的确认。
 *   删除语义：git-mediawiki 无法真正删网页，只能改写正文（wikitext 页写
 *   [[Category:Deleted]]；Scribunto/CSS/JS/JSON 页写同格式注释占位）——
 *   被删页面仍会在线上存在，发布末尾会提醒去线上真正删除。
 */
'use strict';

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const cfg = require('../lib/config.js').load();
const REPO_DIR = cfg.wikiRepo;
const CONTENT_DIR = cfg.contentDir;
const TIMEOUT_MS = cfg.timeoutMs;

// 内容树同步模块（content/ <-> 扁平仓库）
const contentSync = require('./content-sync.js');

// ---------------------------------------------------------------------------
// 删除语义（git-mediawiki 无法真正删除页面，只能改写正文）
//   - wikitext 页：helper 会把正文替换为 [[Category:Deleted]]（页面仍在 → 需线上真删）
//   - 其它内容模型：Scribunto / sanitized-css / css / javascript / json 写 wikitext 会被
//     各自的内容校验拒绝（helper 还会把该 API 错误误报成 non-fast-forward）
//     → 改为「清空 + 同格式注释占位」，仍由管理员在线上真正删除
// ---------------------------------------------------------------------------
const WIKITEXT_DELETED = '[[Category:Deleted]]';
const STUB_CONTENT = [
  { models: ['Scribunto'],
    text: `-- ${WIKITEXT_DELETED} 本页已废弃：原内容已清空，请在线上删除本页。\n` },
  { models: ['sanitized-css', 'css', 'less'],
    text: `/* ${WIKITEXT_DELETED} 本页已废弃：原内容已清空，请在线上删除本页。 */\n` },
  { models: ['javascript'],
    text: `// ${WIKITEXT_DELETED} 本页已废弃：原内容已清空，请在线上删除本页。\n` },
  { models: ['json'],
    text: `{"_comment": "${WIKITEXT_DELETED} 本页已废弃：原内容已清空，请在线上删除本页。"}\n` },
];

// 扁平文件名 -> 页面标题（%2F -> /、_ -> 空格）
function flatTitle(name) {
  const stem = name.endsWith('.mw') ? name.slice(0, -3) : name;
  try { return decodeURIComponent(stem).replace(/_/g, ' '); } catch (e) { return stem.replace(/_/g, ' '); }
}

// 查询线上页面内容模型（匿名只读 prop=info）；返回 Map(标题 -> 模型/null 表示线上不存在)
async function fetchContentModels(titles) {
  const out = new Map();
  const BASE = cfg.apiUrl || '';
  if (!BASE || !titles.length) return out;
  for (let i = 0; i < titles.length; i += 50) {
    const batch = titles.slice(i, i + 50);
    try {
      const res = await fetch(BASE + '?' + new URLSearchParams({
        format: 'json', action: 'query', prop: 'info', titles: batch.join('|'),
      }), { headers: { 'User-Agent': 'git-mediawiki-tools/publish' } });
      const data = await res.json();
      for (const p of Object.values((data.query && data.query.pages) || {})) {
        if (!p || !p.title) continue;
        out.set(p.title.replace(/_/g, ' '), p.missing ? null : (p.contentmodel || undefined));
      }
    } catch (e) {
      console.log(`   ⚠️ 查询内容模型失败（${e.message}），按 wikitext 处理`);
    }
  }
  return out;
}

function askYesNo(question) {
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => { rl.close(); resolve(/^y(es)?$/i.test(String(answer).trim())); });
  });
}

// 删除预检：列出待删页面并确认；对 git-mediawiki 删不掉的页面写“同格式占位”到 content/
// （随本次发布上线）。返回 [{ name, title, model, stub }] 供发布末尾提醒。
async function prepareDeletions(names, assumeYes) {
  const plan = names.map((name) => ({ name, title: flatTitle(name), model: undefined, stub: null }));
  console.log('');
  console.log(`⚠️ 待删除页面 ${plan.length} 个（content/ 中已不存在，扁平仓库仍跟踪）：`);
  for (const p of plan) console.log('   - ' + p.title);
  console.log('   注意：git-mediawiki 只能改写正文，页面本身仍存在，最终需要在线上真正删除。');

  if (!assumeYes) {
    if (!process.stdin.isTTY) {
      console.log('非交互终端无法确认：请加 --yes（或设 MW_PUBLISH_YES=1）明确同意后再发布。已中止。');
      process.exit(1);
    }
    const ok = await askYesNo('确认按此处置（删除/清空占位）并随本次发布上线？[y/N] ');
    if (!ok) {
      console.log('已取消发布（未改动任何文件）。');
      console.log('若这些页面只是没同步进 content/，请先执行 node bin/content-sync.js mirror 补回后重试。');
      process.exit(1);
    }
  }

  const models = await fetchContentModels(plan.map((p) => p.title));
  const allMw = contentSync.listFlat(REPO_DIR).mw;
  for (const p of plan) {
    if (contentSync.isImage(p.name)) {
      p.stub = 'image';
      console.log(`   ↳ ${p.title}：二进制文件，需由管理员在线上删除（本次仅从本地移除）`);
      continue;
    }
    const model = models.get(p.title);
    p.model = model === null ? '(线上不存在)' : (model || 'wikitext');
    if (p.model === '(线上不存在)' || p.model === 'wikitext') continue; // 走 helper 的 [[Category:Deleted]]
    const stub = (STUB_CONTENT.find((s) => s.models.includes(p.model)) || {}).text;
    if (!stub) {
      console.log(`   ↳ ${p.title}：内容模型 ${p.model} 无对应占位格式，按原样提交（可能被服务端拒绝）`);
      continue;
    }
    const rel = contentSync.mirrorRel(p.name, allMw);
    const dst = path.join(CONTENT_DIR, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, stub);
    p.stub = model;
    console.log(`   ↳ ${p.title}（${model}）：无法由 git-mediawiki 删除 → 已清空为同格式占位（content/${rel}）`);
  }
  return plan;
}

// 发布末尾提醒：以上页面只是被改写正文，仍需在线上真正删除
function reportDeletions(plan) {
  if (!plan || !plan.length) return;
  console.log('');
  console.log('===== 需在线上真正删除的页面 =====');
  console.log('以下页面在 content/ 中已删除，本次发布只是改写了线上正文，页面本身仍然存在：');
  for (const p of plan) {
    const how = p.stub === 'image' ? '二进制文件，已从本地移除（线上需管理员删除）'
      : p.stub ? `已清空为 ${p.stub} 同格式占位注释`
        : `已替换为 ${WIKITEXT_DELETED}`;
    console.log(`   - ${p.title}（${how}）`);
  }
  console.log('请在 wiki 上用 Special:Delete 或 API action=delete 真正删除这些页面，然后本地按需收尾：');
  console.log('  node bin/content-sync.js mirror   # 把扁平仓库（已无这些页）同步回 content/');
}

// git-mediawiki 的 helper 失败时 `git fetch` 仍可能返回 0（git 视为“无新引用”），
// 失败信息只在输出里；若不识别会把失败当成功，用陈旧引用继续。
const FETCH_FAIL_RE = /Failed to log in|Can't connect|could not read ref|fatal:|error:/i;

// ---------------------------------------------------------------------------
// 远程角色（config.json 的 remotes；未配置时 pushOrder 里每个远程都按 primary）
//   primary 主站    ：主要推送的站点，必须成功
//   accel   加速链接：绑定某个源站（binds）的同一 wiki 端点。推送成功即视为源站已上线，
//                   不再单独推源站（只把修订号同步过去 + 对齐引用）；加速失败则回退推源站
//   mirror  镜像站  ：独立站点，各自有修订体系；推送后不会立即同步主站（需等其自身同步），
//                   也不与其它远程互相复制修订号
// 例："remotes": { "origin": {"role":"primary"},
//                  "accel": {"role":"accel","binds":"origin"},
//                  "mirror": {"role":"mirror"} }
// ---------------------------------------------------------------------------
const ROLE_LABEL = { primary: '主站', accel: '加速链接', mirror: '镜像站' };

function resolveRemotes() {
  const order = (cfg.pushOrder.length ? cfg.pushOrder : [cfg.remote]).slice();
  const specs = cfg.remotes || {};
  // 环境变量强制指定顺序（MW_PUSH_ORDER/GWMW_REMOTE）时只推列出的远程；否则把配置里
  // 其它远程按配置顺序补进来。
  if (!cfg.pushOrderOnly) {
    for (const name of Object.keys(specs)) if (!order.includes(name)) order.push(name);
  }
  return order.map((name) => {
    const spec = specs[name] || {};
    const role = ['primary', 'accel', 'mirror'].includes(spec.role) ? spec.role : 'primary';
    return {
      name, role, binds: role === 'accel' ? (spec.binds || null) : null,
      verifyParity: spec.verifyParity !== false, url: '',
    };
  });
}

// 推送顺序与角色（默认＝pushOrder，每个都是主站）
const REMOTES = resolveRemotes();
const REMOTE_NAMES = REMOTES.map((r) => r.name);

function roleLabel(rem) {
  return `${ROLE_LABEL[rem.role] || rem.role}${rem.binds ? `（绑定 ${rem.binds}）` : ''}`;
}

// 远程可选选项：verifyParity=false 时不做“加速链接同后端”校验（默认做）
function wantsParityCheck(rem) {
  return rem.verifyParity !== false;
}

// --- 远程可达性预检（DNS/HTTP）------------------------------------------------
// 非 http(s) 远程（如本地测试用的裸仓路径）直接放过。
// 目的：加速链接域名解析不了时马上给出明确原因，而不是等 helper 超时 10 分钟。
async function preflightRemote(rem) {
  const base = (rem.url || '').replace(/^mediawiki::/, '');
  if (!/^https?:/i.test(base)) return { ok: true };
  const url = base.replace(/\/+$/, '') + '/api.php';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(url + '?' + new URLSearchParams({
      format: 'json', action: 'query', meta: 'siteinfo', siprop: 'general',
    }), { headers: { 'User-Agent': 'git-mediawiki-tools/publish' }, signal: ctrl.signal });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}（${url}）` };
    const data = await res.json();
    const g = (data.query && data.query.general) || {};
    return { ok: true, site: g.sitename || '', url };
  } catch (e) {
    const code = (e.cause && e.cause.code) || (e.name === 'AbortError' ? '超时' : e.message);
    return { ok: false, reason: `无法访问 ${url}（${code}）` };
  } finally {
    clearTimeout(timer);
  }
}

// --- 同后端校验 -------------------------------------------------------------
// 读站点最近若干条 recentchanges 做指纹（revid + 页面 + 用户）。
// 同一后端（同一 DB）的两站点，这些信息应当完全一致。
async function siteFingerprint(rem) {
  const api = remoteApiUrl(rem);
  if (!api) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(api + '?' + new URLSearchParams({
      format: 'json', action: 'query', list: 'recentchanges', rclimit: '5',
      rctype: 'edit|new', rcprop: 'title|user|timestamp|ids',
    }), { headers: { 'User-Agent': 'git-mediawiki-tools/publish' }, signal: ctrl.signal });
    const data = await res.json();
    const items = (((data.query && data.query.recentchanges) || [])).filter((c) => c.revid)
      .map((c) => `${c.revid}|${c.title}|${c.user}`);
    return { items, latest: items.length ? Math.max(...items.map((s) => Number(s.split('|')[0]))) : 0 };
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// 纯函数：比对两个指纹（便于测试）
function compareFingerprints(a, b) {
  if (!a || !b) return { same: null, diffs: [] };
  const diffs = [];
  if (a.latest !== b.latest) diffs.push(`最新修订 ${a.latest} vs ${b.latest}`);
  const headA = a.items.slice(0, 3).join(' / ');
  const headB = b.items.slice(0, 3).join(' / ');
  if (headA !== headB) diffs.push(`最近修订不同：「${headA}」 vs 「${headB}」`);
  return { same: diffs.length === 0, diffs };
}

// 加速链接能否代推源站：先验证两者是同一后端（同一 DB、修订号一致）
async function verifySameBackend(accelRem, srcRem) {
  if (!wantsParityCheck(accelRem)) return { same: true, skipped: true, diffs: [] };
  const [a, b] = await Promise.all([siteFingerprint(accelRem), siteFingerprint(srcRem)]);
  return compareFingerprints(a, b);
}

// 两个远程是否同一站点（只有 accel ↔ 它绑定的源站才是）——只有同站点才能互相同步修订号；
// 独立镜像站各有自己的修订体系，复制修订号会破坏它自己的“非快进”判断。
function sameSite(from, to) {
  const a = REMOTES.find((x) => x.name === from);
  const b = REMOTES.find((x) => x.name === to);
  if (!a || !b) return false;
  if (a.role === 'accel' && a.binds === b.name) return true;
  if (b.role === 'accel' && b.binds === a.name) return true;
  return false;
}

// 解析 git-mediawiki fetch 输出里的导入修订：`  1/3: Revision #1037 of 页面名`
function parseImportedRevisions(log) {
  const out = [];
  for (const line of log.split('\n')) {
    const m = line.match(/\d+\/\d+:\s*Revision #(\d+) of (.+?)\s*$/);
    if (m) out.push({ rev: Number(m[1]), page: m[2].replace(/%2F/g, '/') });
  }
  return out;
}

// 每个远程推送前各自 sync 一次（fetch + 采用/变基）：
//   - 线上 tip 是本地 HEAD 的后代 → fast-forward 采用（含其内容，避免“丢弃修订”）
//   - 分叉：base=true 的远程（本次发布的基准远程）或 mirror → rebase；
//     同 wiki 的兄弟远程（accel/origin 导入链 SHA 不同）→ 不 rebase，交给修订号同步+引用对齐
async function syncRemote(rem, opts = {}) {
  const r = rem.name;
  const fetched = await runWithProgress(['fetch', r]);
  if (fetched.timedOut || fetched.code !== 0 || FETCH_FAIL_RE.test(fetched.log)) {
    return { ok: false, reason: '拉取失败/超时', log: fetched.log, imported: [] };
  }
  const imported = parseImportedRevisions(fetched.log);
  const tip = (await runGit(['rev-parse', `refs/remotes/${r}/master`])).out.trim();
  const head = (await runGit(['rev-parse', 'master'])).out.trim();
  if (tip && head && tip !== head) {
    const tipAhead = (await runGit(['merge-base', '--is-ancestor', head, tip])).code === 0;
    const headAhead = (await runGit(['merge-base', '--is-ancestor', tip, head])).code === 0;
    if (tipAhead) {
      await runGit(['reset', '--hard', tip]);
      console.log(`   ⚠️ ${r} 已有新修订（可能由他人上传），已采用并刷新到本地`);
    } else if (!headAhead && (opts.base || rem.role === 'mirror')) {
      const rb = await runWithProgress(['rebase', `${r}/master`]);
      if (rb.timedOut || rb.code !== 0) {
        return { ok: false, reason: `变基到 ${r} 失败（可能有冲突）`, log: rb.log, imported };
      }
      console.log(`   已变基到 ${r}/master`);
    } else if (!headAhead) {
      console.log(`   （${r} 与本地导入链分叉：跳过变基，用修订号同步 + 引用对齐）`);
    }
  }
  return { ok: true, imported, tip, head };
}

// 该远程对应的 MediaWiki API（由 `git remote get-url` 的 mediawiki::URL 推导）
function remoteApiUrl(rem) {
  if (!rem.url) return '';
  const base = rem.url.replace(/^mediawiki::/, '');
  if (!/^https?:/i.test(base)) return '';
  return base.replace(/\/+$/, '') + '/api.php';
}

// 推送失败后判断是不是「推送期间服务端有人上传」：
//   helper 在推送前会打印 `Last remote revision found is N.`（推送开始时线上的最大修订号），
//   失败后用该站点 API 查一次最新修订；若比 N 新 → 说明推送窗口内有人上传/站端编辑。
async function reportRemoteRace(rem, pushLog) {
  const m = String(pushLog || '').match(/Last remote revision found is (\d+)/);
  if (!m) return false;
  const before = Number(m[1]);
  const api = remoteApiUrl(rem);
  if (!api) return false;
  try {
    const res = await fetch(api + '?' + new URLSearchParams({
      format: 'json', action: 'query', list: 'recentchanges', rclimit: '5',
      rctype: 'edit|new', rcprop: 'title|user|timestamp|ids',
    }), { headers: { 'User-Agent': 'git-mediawiki-tools/publish' } });
    const data = await res.json();
    const rc = ((data.query && data.query.recentchanges) || []).filter((c) => c.revid);
    const latest = rc.reduce((a, c) => Math.max(a, c.revid), 0);
    if (latest > before) {
      const items = rc.filter((c) => c.revid > before).slice(0, 3)
        .map((c) => `rev${c.revid} ${c.title}（${c.user}）`).join('、');
      console.log('   ⚠️ 检测到推送期间该站点有新修订：' + items);
      console.log(`   → ${rem.name}${rem.url ? '（' + rem.url + '）' : ''} 有人上传 / 站端刚编辑`
        + '（不是本地 notes 落后），请先 `npm run sync` 确认后再重新发布。');
      return true;
    }
  } catch (e) { /* 网络问题不额外报错 */ }
  return false;
}

function showProgress(line) {
  const pushed = line.match(/Pushed\s+file:.*\s-\s(.*)$/);
  if (pushed) {
    process.stdout.write(`\r\x1b[K[发布中] 已推送: ${pushed[1]}`);
    return;
  }
  const page = line.match(/^page\s+(\d+)\/(\d+):/);
  if (page) {
    const pct = Math.round((page[1] / page[2]) * 100);
    process.stdout.write(`\r\x1b[K[${String(pct).padStart(3)}%] 检查页面 ${page[1]}/${page[2]}`);
    return;
  }
  const rev = line.match(/Revision\s+#(\d+)\s+of\s+(.*)$/);
  if (rev) {
    process.stdout.write(`\r\x1b[K[处理中] 修订 #${rev[1]}: ${rev[2]}`);
  }
}

function runGit(args) {
  return new Promise((resolve) => {
    const p = spawn('git', args, { cwd: REPO_DIR });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', (code) => resolve({ code, out }));
  });
}

// 带进度条地运行 git 命令（后台写日志 + 轮询 + 硬超时）
function runWithProgress(args) {
  return new Promise((resolve) => {
    const logFile = path.join(os.tmpdir(), `mw-pub-${Date.now()}-${Math.random().toString(36).slice(2)}.log`);
    const outFd = fs.openSync(logFile, 'w');
    const p = spawn('git', args, { cwd: REPO_DIR, stdio: ['ignore', outFd, outFd] });

    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; p.kill('SIGTERM'); }, TIMEOUT_MS);
    const poll = setInterval(() => {
      try {
        const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n');
        if (lines.length) showProgress(lines[lines.length - 1]);
      } catch (e) { /* */ }
    }, 300);

    p.on('close', (code) => {
      clearInterval(poll);
      clearTimeout(timer);
      fs.closeSync(outFd);
      process.stdout.write('\r\x1b[K');
      const log = fs.readFileSync(logFile, 'utf8');
      fs.unlinkSync(logFile);
      if (timedOut) {
        try { execSync('pkill -f "git-remote-mediawiki"'); } catch (e) { /* */ }
      }
      resolve({ code, log, timedOut });
    });
  });
}

// 把指定远程的跟踪引用全部对齐到本地 master
async function alignRefs(remote) {
  await runGit(['update-ref', `refs/mediawiki/${remote}/master`, 'master']);
  await runGit(['update-ref', `refs/remotes/${remote}/master`, 'master']);
  await runGit(['update-ref', `refs/remotes/${remote}/HEAD`, 'master']);
}

// 打印推送结果摘要
function showPushResult(remote, ok, log) {
  if (ok) {
    console.log(`✅ ${remote} 推送成功`);
    console.log('--- 推送日志 ---');
    console.log(log.trim().split('\n').slice(-5).join('\n'));
  } else {
    console.log(`❌ ${remote} 推送失败/超时`);
    console.log('--- 推送日志（尾部）---');
    console.log(log.trim().split('\n').slice(-10).join('\n'));
  }
}

// 上一远程推送成功后：把它记录的修订号同步到下一远程的 notes 并对齐引用，
// 否则下一远程（同一 wiki 的镜像/主站）会因「本地修订 < 远程修订」被判非快进而被拒绝。
async function syncRevToRemote(fromRemote, toRemote) {
  console.log('');
  console.log(`===== 同步 ${toRemote} 追踪（${fromRemote} 修订号 → ${toRemote} notes + 对齐引用）=====`);
  const note = await runGit(['notes', `--ref=refs/notes/${fromRemote}/mediawiki`, 'show', 'master']);
  const m = note.out.match(/mediawiki_revision:\s*(\d+)/);
  if (m) {
    await runGit([
      'notes', `--ref=refs/notes/${toRemote}/mediawiki`, 'add', '-f', '-m',
      `mediawiki_revision: ${m[1]}`, 'master',
    ]);
    console.log(`已将修订号 ${m[1]} 写入 ${toRemote} notes`);
  } else {
    // 读不到上一远程修订号（例如该提交无 note），退化为 fetch 该远程导入修订
    console.log(`（未从 ${fromRemote} notes 读到修订号，改用 fetch ${toRemote} 导入）`);
    const pf = await runWithProgress(['fetch', toRemote]);
    console.log(pf.log.trim().split('\n').slice(-3).join('\n'));
  }
  await alignRefs(toRemote);
  console.log(`${toRemote} 引用已对齐到 master`);
}

async function main() {
  // 若第一个参数是已知远程名，视为来源参数并忽略——
  // 发布按配置的远程角色/顺序（primary 主站 / accel 加速链接 / mirror 镜像站）推送
  // --yes/-y（或环境变量 MW_PUBLISH_YES=1）＝跳过删除确认，供脚本化使用
  let args = process.argv.slice(2);
  const assumeYes = args.includes('--yes') || args.includes('-y') || process.env.MW_PUBLISH_YES === '1';
  args = args.filter((a) => !a.startsWith('-'));
  const remotes = (await runGit(['remote'])).out.trim().split(/\s+/).filter(Boolean);
  if (remotes.includes(args[0])) {
    console.log(`（来源参数 "${args[0]}" 已忽略：发布按 ${REMOTE_NAMES.join(' → ')} 顺序推送）`);
    args = args.slice(1);
  }
  for (const rem of REMOTES) {
    const u = await runGit(['remote', 'get-url', rem.name]);
    rem.url = u.code === 0 ? u.out.trim() : '';
  }
  const msg = args[0] || `自动提交 via ${cfg.wikiName || 'publish'}`;
  try { execSync('pkill -f "git-remote-mediawiki"', { stdio: 'ignore' }); } catch (e) { /* */ }

  // 0. 内容树 content/ → 扁平仓库：自动回写，并入发布流程（含冲突检测与页面删除）
  const contentMap = contentSync.scanContent(CONTENT_DIR).map;
  const contentReady = fs.existsSync(CONTENT_DIR) && contentMap.size > 0;
  let deletePlan = [];
  if (contentReady) {
    console.log('');
    console.log('===== 回写内容树 content/ → 扁平仓库 =====');

    // 0a. 若上次生成的冲突 diff 被人工改过（任何外部差异编辑器改完保存）→
    //     复检后写回两侧（会产生新冲突则回滚），然后继续发布，无需 --force。
    //     若冲突是用 git-merge 写进 git 的（VS Code 合并编辑器）：工作树已无冲突标记 → 同步回 content/ 并清 unmerged。
    contentSync.finishGitMerges(REPO_DIR, CONTENT_DIR, REPO_DIR);

    // 0b. 删除预检：页面「content/ 没有、扁平仓库仍跟踪」＝待删除，先列清单并等确认；
    //     对 git-mediawiki 删不掉的（非 wikitext 内容模型）改为清空 + 同格式注释占位。
    const pending = contentSync.analyzePublish(REPO_DIR, CONTENT_DIR, REPO_DIR);
    if (!pending.conflict.length && pending.deletion.length) {
      deletePlan = await prepareDeletions(pending.deletion, assumeYes);
    }

    const pub = contentSync.applyPublish(REPO_DIR, CONTENT_DIR, REPO_DIR);
    if (!pub.ok) {
      console.log('❌ 检测到内容冲突，发布中止（未改动任何文件）：');
      for (const n of pub.conflict) console.log('   ! ' + n);
      console.log('   原因: 这些页面在 content/ 与扁平仓库被各自修改，需先人工合并后再发布');
      if (pub.gitConflicts && pub.gitConflicts.created.length) {
        console.log(`   ⚠️ 冲突已写进 git（扁平仓库 index，UU）——直接在 VS Code 里解决：`);
        console.log('     源代码管理 →「合并更改」→ 点文件上的「在合并编辑器中解决」→ 选 Accept Current/Incoming →「完成合并」');
        console.log('     然后重跑 publish：结果会进暂存区、写回 content/，再继续发布（放弃：content-sync.js git-merge --abort）');
      } else if (pub.gitConflicts && pub.gitConflicts.skipped.length) {
        console.log('   ⚠️ 这些冲突无法三方合并（二进制 / 缺一侧）：用 content-sync.js resolve 选一侧');
        for (const s of pub.gitConflicts.skipped) console.log('     - ' + s.name + '（' + s.why + '）');
      } else {
        console.log('   处理: 在 content/ 对应文件与扁平仓库间取一致后，重新运行 node publish.js');
      }
      process.exit(1);
    }
    if (pub.written) console.log(`已将 ${pub.written} 个内容树改动回写扁平仓库`);
    if (pub.deletion.length) {
      console.log(`⚠️ 已按确认把 ${pub.deletion.length} 个页面从扁平仓库移除（线上将被改写为占位）：`);
      for (const n of pub.deletion) console.log('   - ' + n);
    }
    if (!pub.written && !pub.deletion.length) console.log('（无内容树改动）');
  }

  // 检查是否有改动：未提交的改动 或 未推送的提交
  const st = await runGit(['status', '--porcelain']);
  const first = REMOTE_NAMES[0];
  const ahead = {};
  for (const r of REMOTE_NAMES) {
    ahead[r] = parseInt((await runGit(['rev-list', '--count', `${r}/master..master`])).out.trim(), 10);
  }
  const hasUncommitted = st.out.trim().length > 0;
  const hasUnpushed = Object.values(ahead).some((n) => n > 0);

  if (!hasUncommitted && !hasUnpushed) {
    console.log('没有需要发布的改动（工作树干净且无未推送提交）');
    return;
  }

  if (hasUncommitted) {
    console.log('===== 待发布内容 =====');
    console.log(st.out.trim());

    console.log('');
    console.log(`===== 本地提交: ${msg} =====`);
    await runGit(['add', '-A']);
    const commit = await runGit(['commit', '-m', msg]);
    console.log(commit.out.trim());
  } else {
    console.log('===== 已有未推送的提交，直接推送 =====');
    const lg = await runGit(['log', '--oneline', `${first}/master..master`]);
    console.log(lg.out.trim());
  }

  // 1. 逐远程：每个先各自 sync（fetch + 采用线上新修订 / 变基），再推送。
  //    角色：主站必推；加速链接成功后其绑定源站视为已上线（跳过源站推送，只同步修订号+对齐引用）；
  //    镜像站独立推送（推送后不会立即同步主站，需等其自身同步）。
  const results = {};
  const skipped = [];
  const covered = new Set();     // 已被加速链接代推的远程
  let lastOk = null;
  for (const rem of REMOTES) {
    const r = rem.name;
    if (covered.has(r)) {
      const accelRem = REMOTES.find((x) => x.name === lastOk);
      const verdict = accelRem && accelRem.binds === r
        ? await verifySameBackend(accelRem, rem) : { same: null, diffs: [] };
      if (verdict.same !== true) {
        console.log('');
        console.log(verdict.same === false
          ? `⚠️ 加速链接 ${lastOk} 与其绑定源站 ${r} 看起来不是同一后端，不能代推：`
          : `⚠️ 无法校验加速链接 ${lastOk} 与源站 ${r} 是否同一后端（站点 API 不可用），保守起见不代推：`);
        for (const d of verdict.diffs) console.log('   - ' + d);
        console.log(`   → 继续单独推送 ${r}（确定是同一后端、想跳过校验时，给 ${lastOk} 加 "verifyParity": false）`);
        covered.delete(r);   // 落到下面正常推送
      } else {
        console.log('');
        console.log(`===== 跳过 ${r}（${roleLabel(rem)}）：内容已由加速链接 ${lastOk} 上线`
          + `${verdict.skipped ? '（已按配置跳过同后端校验）' : '（已校验两站修订一致）'} =====`);
        if (lastOk && lastOk !== r) await syncRevToRemote(lastOk, r);
        await alignRefs(r);
        results[r] = true;
        skipped.push(`${r}（由 ${lastOk} 代推）`);
        continue;
      }
    }
    if (rem.role === 'accel' && rem.binds && results[rem.binds]) {
      console.log('');
      console.log(`===== 跳过 ${r}（${roleLabel(rem)}）：绑定源站 ${rem.binds} 已推送成功 =====`);
      results[r] = true;
      skipped.push(`${r}（源站 ${rem.binds} 已推送）`);
      continue;
    }
    console.log('');
    console.log(`===== 同步 + 推送 ${r}（${roleLabel(rem)}${rem.url ? '，' + rem.url : ''}）=====`);
    const pre = await preflightRemote(rem);
    if (!pre.ok) {
      console.log(`❌ ${r} 预检失败：${pre.reason}`);
      console.log('   （地址解析不了 / 站点不可达；跳过该远程，继续其它远程）');
      results[r] = false;
      continue;
    }
    if (pre.site) console.log(`   站点：${pre.site}`);
    const sync = await syncRemote(rem, { base: !lastOk });
    if (!sync.ok) {
      console.log(`❌ ${r} ${sync.reason}`);
      console.log(sync.log.trim().split('\n').slice(-10).join('\n'));
      results[r] = false;
      continue;
    }
    if (lastOk && lastOk !== r && sameSite(lastOk, r)) {
      await syncRevToRemote(lastOk, r);   // 同一站点：把上一远程修订号同步给当前远程
    }
    const pr = await runWithProgress(['push', r, 'master:master']);   // 显式 refspec：不依赖 branch.<b>.remote 上游配置（新镜像站首次推送也能用）
    const ok = pr.code === 0 && !pr.timedOut;
    showPushResult(r, ok, pr.log);
    results[r] = ok;
    if (ok) {
      await alignRefs(r);
      lastOk = r;
      if (rem.role === 'accel' && rem.binds) covered.add(rem.binds);
    } else {
      await reportRemoteRace(rem, pr.log);   // 推送期间服务端是否有人上传
    }
  }

  const okList = REMOTE_NAMES.filter((r) => results[r]);
  const failList = REMOTE_NAMES.filter((r) => !results[r]);
  if (!okList.length) {
    console.log('');
    console.log('❌ 全部推送失败/超时（wiki 上可能有他人更新，或网络慢）');
    console.log('提示: 请先运行 npm run sync 再重试');
    process.exit(1);
  }
  if (failList.length) {
    console.log('');
    console.log(`⚠️  已成功推送 ${okList.join('、')}，但 ${failList.join('、')} 失败/超时`);
    const failed = REMOTES.filter((x) => !results[x.name]);
    const accelFailed = failed.filter((x) => x.role === 'accel' && x.binds);
    if (accelFailed.length) {
      console.log(`   加速链接失败时会回退推送其绑定源站（${accelFailed.map((x) => x.binds).join('、')}）`);
    }
    console.log('   可稍后运行 npm run sync 同步追踪');
    if (failed.some((x) => x.role === 'mirror')) {
      console.log('   镜像站若是首次推送，需先播种它的引用与 notes（git-mediawiki 要求，见 README）；\n'
        + '   独立镜像站的修订号体系与主站不同，不能互相对齐。');
    }
  }
  if (skipped.length) {
    console.log('');
    console.log(`ℹ️  未单独推送：${skipped.join('、')}`);
    console.log('   加速链接与其绑定源站是同一站点，内容已经上线；若要强制单独推源站：'
      + 'MW_PUSH_ORDER=<源站> npm run publish -- "说明"');
  }
  const mirrorOk = REMOTES.filter((x) => x.role === 'mirror' && results[x.name]);
  if (mirrorOk.length) {
    console.log(`ℹ️  镜像站已推送：${mirrorOk.map((x) => x.name).join('、')}`
      + '（镜像站不会立即同步主站，需等待其自身同步）');
  }

  // 4. 推送后最终同步：导入修订 + 对齐“同站点”远程引用到 master。
  //    不用 git pull：mediawiki 远程的 FETCH_HEAD 会写多条导致
  //    "Cannot rebase onto multiple branches"。
  //    两个要点：① 推送窗口内线上又更新时**采用**新修订（不能反向对齐丢内容）；
  //    ② 只对齐本次推送成功的同站点远程，失败/独立镜像站的引用保持不动，
  //       否则本地会误判为“已同步”，下次发布不再重试。
  console.log('');
  console.log('===== 推送后同步（导入修订 + 对齐引用）=====');
  const pf = await runWithProgress(['fetch', first]);
  const afterImported = parseImportedRevisions(pf.log);
  const tip2 = (await runGit(['rev-parse', `refs/remotes/${first}/master`])).out.trim();
  const head2 = (await runGit(['rev-parse', 'master'])).out.trim();
  if (tip2 && head2 && tip2 !== head2
      && (await runGit(['merge-base', '--is-ancestor', head2, tip2])).code === 0) {
    await runGit(['reset', '--hard', tip2]);
    console.log(`⚠️ 推送后 ${first} 又有新修订：`
      + (afterImported.length ? afterImported.map((i) => `rev${i.rev} ${i.page}`).join('、') : '（见日志）')
      + '，已并入本地');
  }
  const sameGroup = REMOTE_NAMES.filter((r) => r === first || sameSite(first, r));
  for (const r of sameGroup) {
    if (r !== first && !results[r]) continue;   // 未推成功的不要对齐（会掩盖待推送内容）
    await alignRefs(r);
  }
  const onlyNames = REMOTE_NAMES.filter((r) => !sameGroup.includes(r));
  if (onlyNames.length) console.log(`（${onlyNames.join('、')} 属独立站点，引用各自保留）`);
  console.log('--- 同步日志 ---');
  console.log(pf.log.trim().split('\n').slice(-3).join('\n'));
  console.log(`引用已对齐到 master（同站点远程：${sameGroup.join('、')}）`);

  // 4b. 内容树刷新：把扁平侧的改动（含直接改 .mw 的扁平直改/新增）同步回 content/，
  //     使发布后两侧保持一致（已删除页面不会复活）。
  if (contentReady) {
    const r = contentSync.refreshContentFromFlat(REPO_DIR, CONTENT_DIR, REPO_DIR);
    console.log('');
    console.log(`内容树已刷新: 新增 ${r.added}，更新 ${r.updated}`
      + (r.skippedDelete ? `，跳过 ${r.skippedDelete} 个已删除页面` : ''));
  }


  // 5. 可选：确保 JSON 数据页使用 JSON 内容模型（config.json 的 jsonContentModels=true 时启用）。
  //    git-remote-mediawiki 导入默认按 wikitext 创建页面，导致 /Data 这类
  //    数据页以纯文本显示而非 JSON 数据视图，这里推送后统一修正。
  if (cfg.jsonContentModels) {
    await ensureJsonContentModels();
  }

  // 6. 删除遗留提醒：git-mediawiki 的“删除”只是把正文改写为占位，页面需在线上真正删除。
  reportDeletions(deletePlan);
}

// 找出仓库里内容为合法 JSON 的 .mw 页面（如 命名空间:数据页/Data）
function listJsonDataFiles() {
  const files = [];
  for (const ent of fs.readdirSync(REPO_DIR, { withFileTypes: true })) {
    if (!ent.isFile() || !ent.name.endsWith('.mw')) continue;
    const text = fs.readFileSync(path.join(REPO_DIR, ent.name), 'utf8').trim();
    if (!/^\s*[{\[]/.test(text)) continue;
    try {
      JSON.parse(text);
      files.push(decodeURIComponent(ent.name.slice(0, -3))); // 文件名 URL 解码为页面标题
    } catch (e) { /* 非合法 JSON，忽略 */ }
  }
  return files;
}

// 推送后通过 API 把 JSON 数据页的内容模型设为 json（幂等，跳过已是 json 的页）
async function ensureJsonContentModels() {
  console.log('');
  console.log('===== 确保 JSON 数据页内容模型 =====');
  const titles = listJsonDataFiles();
  if (!titles.length) {
    console.log('（无 JSON 数据页，跳过）');
    return;
  }
  const user = execSync(
    `git config --get remote.${cfg.remote}.mwlogin`, { cwd: REPO_DIR }
  ).toString().trim();
  const pass = execSync(
    `git config --get remote.${cfg.remote}.mwpassword`, { cwd: REPO_DIR }
  ).toString().trim();
  if (!user || !pass) {
    console.log(`⚠️ 未读取到 mediawiki 凭据（remote.${cfg.remote}.mwlogin/mwpassword），跳过`);
    return;
  }

  const BASE = cfg.apiUrl || '';
  if (!BASE) {
    console.log('⚠️ 未配置 apiUrl（config.json 的 apiUrl 或 wikiBaseUrl），跳过');
    return;
  }
  // Node fetch 不自动保存 Cookie，而 MediaWiki 登录依赖会话 Cookie，
  // 这里手动维护 Cookie 罐（Set-Cookie → 下次请求带上）。
  const cookieJar = {};
  const cookieHeader = () =>
    Object.entries(cookieJar).map(([k, v]) => `${k}=${v}`).join('; ');
  const storeCookies = (res) => {
    const setCookies = res.headers.getSetCookie
      ? res.headers.getSetCookie()
      : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);
    for (const c of setCookies) {
      const [pair] = c.split(';');
      const eq = pair.indexOf('=');
      if (eq > 0) cookieJar[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
    }
  };
  const q = async (params) => {
    const res = await fetch(
      BASE + '?' + new URLSearchParams({ format: 'json', ...params }),
      { headers: { Cookie: cookieHeader() } });
    storeCookies(res);
    return res.json();
  };
  const post = async (data) => {
    const res = await fetch(BASE, {
      method: 'POST',
      headers: { Cookie: cookieHeader() },
      body: new URLSearchParams({ format: 'json', ...data }),
    });
    storeCookies(res);
    return res.json();
  };

  try {
    const lt = await q({ action: 'query', meta: 'tokens', type: 'login' });
    const login = await post({
      action: 'login', lgname: user, lgpassword: pass,
      lgtoken: lt.query.tokens.logintoken,
    });
    if (login.login && login.login.result !== 'Success') {
      console.log(`⚠️ 登录失败: ${login.login.reason || '未知原因'}`);
      return;
    }
    const ct = await q({ action: 'query', meta: 'tokens', type: 'csrf' });
    const csrf = ct.query.tokens.csrftoken;

    for (const title of titles) {
      const info = await q({ action: 'query', titles: title, prop: 'info' });
      const pg = Object.values(info.query.pages)[0];
      if (!pg || pg.missing) {
        console.log(`  ⚠️ ${title} 线上不存在`);
        continue;
      }
      if (pg.contentmodel === 'json') {
        console.log(`  ✓ ${title} 已是 json`);
        continue;
      }
      const r = await post({
        action: 'changecontentmodel', title, model: 'json', token: csrf,
      });
      if (r.error) {
        console.log(`  ✗ ${title} -> json 失败: ${r.error.info}`);
      } else {
        console.log(`  ✓ ${title} -> json`);
      }
    }
  } catch (e) {
    console.log(`⚠️ 设置内容模型失败: ${e.message}`);
  }
}

if (require.main === module) main();

module.exports = {
  main, prepareDeletions, reportDeletions, flatTitle, fetchContentModels,
  resolveRemotes, syncRemote, parseImportedRevisions, reportRemoteRace,
  preflightRemote, siteFingerprint, compareFingerprints, verifySameBackend,
  STUB_CONTENT, WIKITEXT_DELETED,
};
