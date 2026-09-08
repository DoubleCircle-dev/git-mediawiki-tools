#!/usr/bin/env node
/**
 * 发布脚本：提交本地修改并推送到 git-mediawiki 远程。
 * 推送顺序取 config.json 的 pushOrder（缺省只推主 remote；可在首位放同一 wiki 的快速镜像）。
 * 用法: node publish.js [提交说明]
 * 示例: node publish.js "更新首页模板"
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

// 推送顺序：默认只推主 remote；若配置了同一 wiki 的镜像端点（快/慢），按序逐个推
const PUSH_ORDER = (cfg.pushOrder.length ? cfg.pushOrder : [cfg.remote]);

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
  // 发布始终按配置的 PUSH_ORDER 顺序推送
  let args = process.argv.slice(2);
  const remotes = (await runGit(['remote'])).out.trim().split(/\s+/).filter(Boolean);
  if (remotes.includes(args[0])) {
    console.log(`（来源参数 "${args[0]}" 已忽略：发布按 ${PUSH_ORDER.join(' → ')} 顺序推送）`);
    args = args.slice(1);
  }
  const msg = args[0] || `自动提交 via ${cfg.wikiName || 'publish'}`;
  try { execSync('pkill -f "git-remote-mediawiki"', { stdio: 'ignore' }); } catch (e) { /* */ }

  // 0. 内容树 content/ → 扁平仓库：自动回写，并入发布流程（含冲突检测与页面删除）
  const contentMap = contentSync.scanContent(CONTENT_DIR).map;
  const contentReady = fs.existsSync(CONTENT_DIR) && contentMap.size > 0;
  if (contentReady) {
    console.log('');
    console.log('===== 回写内容树 content/ → 扁平仓库 =====');
    const pub = contentSync.applyPublish(REPO_DIR, CONTENT_DIR, REPO_DIR);
    if (!pub.ok) {
      console.log('❌ 检测到内容冲突，发布中止（未改动任何文件）：');
      for (const n of pub.conflict) console.log('   ! ' + n);
      console.log('   原因: 这些页面在 content/ 与扁平仓库被各自修改，需先人工合并后再发布');
      console.log('   处理: 在 content/ 对应文件与扁平仓库间取一致后，重新运行 node publish.js');
      process.exit(1);
    }
    if (pub.written) console.log(`已将 ${pub.written} 个内容树改动回写扁平仓库`);
    if (pub.deletion.length) {
      console.log(`⚠️ 将从线上删除 ${pub.deletion.length} 个页面（content/ 中已删除）：`);
      for (const n of pub.deletion) console.log('   - ' + n);
    }
    if (!pub.written && !pub.deletion.length) console.log('（无内容树改动）');
  }

  // 检查是否有改动：未提交的改动 或 未推送的提交
  const st = await runGit(['status', '--porcelain']);
  const first = PUSH_ORDER[0];
  const ahead = {};
  for (const r of PUSH_ORDER) {
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

  // 0. 推送前先用首个远程拉取并变基：把 wiki 上已有的最新修订并入本地，
  //    否则推送会被 helper 判为非快进而拒绝。首个远程通常是同一 wiki 的快端点；
  //    只配置一个远程时，它就是主站本身。
  console.log('');
  console.log(`===== 推送前同步（fetch ${first} + rebase）=====`);
  const prefetch = await runWithProgress(['fetch', first]);
  if (prefetch.timedOut || prefetch.code !== 0) {
    console.log('--- 拉取日志（尾部）---');
    console.log(prefetch.log.trim().split('\n').slice(-10).join('\n'));
    console.log('❌ 推送前拉取失败/超时（网络或 wiki 响应慢）');
    process.exit(1);
  }
  const preRebase = await runWithProgress(['rebase', `${first}/master`]);
  if (preRebase.timedOut || preRebase.code !== 0) {
    console.log('--- 变基日志（尾部）---');
    console.log(preRebase.log.trim().split('\n').slice(-10).join('\n'));
    console.log('❌ 推送前变基失败（可能有冲突）');
    console.log('提示: 解决冲突后运行 git rebase --continue，或中止 git rebase --abort');
    process.exit(1);
  }
  console.log('同步完成');

  // 1. 依序推送 PUSH_ORDER 中的远程（首个往往是最快/主推端点）
  const results = {};
  let lastOk = null;
  for (const r of PUSH_ORDER) {
    if (lastOk && lastOk !== r) {
      await syncRevToRemote(lastOk, r);   // 把上一远程修订号同步给当前远程
    }
    console.log('');
    console.log(`===== 推送 ${r} =====`);
    const pr = await runWithProgress(['push', r]);
    const ok = pr.code === 0 && !pr.timedOut;
    showPushResult(r, ok, pr.log);
    results[r] = ok;
    if (ok) {
      await alignRefs(r);
      lastOk = r;
    }
  }

  const okList = PUSH_ORDER.filter((r) => results[r]);
  const failList = PUSH_ORDER.filter((r) => !results[r]);
  if (!okList.length) {
    console.log('');
    console.log('❌ 全部推送失败/超时（wiki 上可能有他人更新，或网络慢）');
    console.log('提示: 请先运行 node sync.js 再重试');
    process.exit(1);
  }
  if (failList.length) {
    console.log('');
    console.log(`⚠️  已成功推送 ${okList.join('、')}，但 ${failList.join('、')} 失败/超时`);
    console.log('   可稍后运行 node sync.js 同步追踪');
  }

  // 4. 推送后最终同步：导入修订 + 对齐所有远程引用到 master。
  //    不用 git pull：mediawiki 远程的 FETCH_HEAD 会写多条导致
  //    "Cannot rebase onto multiple branches"。
  console.log('');
  console.log('===== 推送后同步（导入修订 + 对齐引用）=====');
  const pf = await runWithProgress(['fetch', first]);
  for (const r of PUSH_ORDER) await alignRefs(r);
  console.log('--- 同步日志 ---');
  console.log(pf.log.trim().split('\n').slice(-3).join('\n'));
  console.log('引用已对齐到 master');

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

main();
