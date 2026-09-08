#!/usr/bin/env node
/**
 * 同步脚本：从 git-mediawiki 远程拉取最新内容到本地扁平仓库，并整理进 content/。
 * 用法: node sync.js [来源]
 *   来源可选（缺省用 config.json 的 remote）:
 *     <remote> - 远程名，如 origin（默认）或其它已配置镜像
 * 示例: node sync.js origin
 */
'use strict';

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const cfg = require('../lib/config.js').load();
const REPO_DIR = cfg.wikiRepo;
const CONTENT_DIR = cfg.contentDir;
const TIMEOUT_MS = cfg.timeoutMs; // 硬超时

// 内容树同步模块（content/ <-> 扁平仓库）
const contentSync = require('./content-sync.js');

// 拉取来源：命令行第一个参数可覆盖（如已配置的镜像 remote），默认主 remote
const REMOTE = process.argv[2] || cfg.remote;

// 解析 git-mediawiki 输出并显示进度
function showProgress(line) {
  const page = line.match(/^page\s+(\d+)\/(\d+):\s*(.*)$/);
  if (page) {
    const pct = Math.round((page[1] / page[2]) * 100);
    process.stdout.write(`\r\x1b[K[${String(pct).padStart(3)}%] 检查页面 ${page[1]}/${page[2]}: ${page[3]}`);
    return;
  }
  const rev = line.match(/Revision\s+#(\d+)\s+of\s+(.*)$/);
  if (rev) {
    process.stdout.write(`\r\x1b[K[导入中] 修订 #${rev[1]}: ${rev[2]}`);
    return;
  }
  const dl = line.match(/Downloading\s+file\s+(.*)$/);
  if (dl) {
    process.stdout.write(`\r\x1b[K[下载中] 媒体: ${dl[1]}`);
  }
}

function runGit(args, { show = false } = {}) {
  return new Promise((resolve) => {
    const p = spawn('git', args, { cwd: REPO_DIR });
    let out = '';
    p.stdout.on('data', (d) => { out += d; if (show) process.stdout.write(d); });
    p.stderr.on('data', (d) => { out += d; if (show) process.stderr.write(d); });
    p.on('close', (code) => resolve({ code, out }));
  });
}

// 运行 git 命令：后台写日志 + 轮询进度 + 硬超时
function runWithProgress(args) {
  return new Promise((resolve) => {
    const logFile = path.join(os.tmpdir(), `mw-sync-${Date.now()}-${Math.random().toString(36).slice(2)}.log`);
    const outFd = fs.openSync(logFile, 'w');
    const p = spawn('git', args, { cwd: REPO_DIR, stdio: ['ignore', outFd, outFd] });

    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; p.kill('SIGTERM'); }, TIMEOUT_MS);
    const poll = setInterval(() => {
      try {
        const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n');
        if (lines.length) showProgress(lines[lines.length - 1]);
      } catch (e) { /* 日志尚未创建 */ }
    }, 300);

    p.on('close', (code) => {
      clearInterval(poll);
      clearTimeout(timer);
      fs.closeSync(outFd);
      process.stdout.write('\r\x1b[K');
      const log = fs.readFileSync(logFile, 'utf8');
      fs.unlinkSync(logFile);
      if (timedOut) {
        try { execSync(`pkill -f "git-remote-mediawiki ${REMOTE}"`); } catch (e) { /* */ }
      }
      resolve({ code, log, timedOut });
    });
  });
}

async function main() {
  try { execSync(`pkill -f "git-remote-mediawiki ${REMOTE}"`, { stdio: 'ignore' }); } catch (e) { /* 无残留 */ }

  console.log(`===== 同步 ${cfg.wikiName} → 本地（来源: ${REMOTE}）=====`);

  // 拉取前记录 content/ 是否有尚未回写的本地改动（避免拉取后整理时被覆盖）
  const contentReady = fs.existsSync(CONTENT_DIR);
  const prePending = contentReady ? contentSync.pendingLocalEdits(REPO_DIR, CONTENT_DIR) : [];

  // 1) 拉取（更新 refs/remotes/<remote>/master）
  console.log('--- 拉取中 ---');
  const fetch = await runWithProgress(['fetch', REMOTE]);
  if (fetch.timedOut || fetch.code !== 0) {
    console.log('');
    console.log('--- 拉取日志（尾部）---');
    console.log(fetch.log.trim().split('\n').slice(-10).join('\n'));
    console.log('');
    console.log('❌ 拉取失败/超时（网络或 wiki 响应慢）');
    process.exit(1);
  }

  // 2) 变基（用显式 ref，避免 git pull 对 mediawiki 远程产生多分支报错）
  console.log('--- 合并本地提交到最新 ---');
  const rebase = await runWithProgress(['rebase', `${REMOTE}/master`]);
  if (rebase.timedOut || rebase.code !== 0) {
    console.log('');
    console.log('--- 变基日志（尾部）---');
    console.log(rebase.log.trim().split('\n').slice(-10).join('\n'));
    console.log('');
    console.log('❌ 变基失败（可能有冲突）');
    console.log('提示: 解决冲突后运行 git rebase --continue，或中止 git rebase --abort');
    process.exit(1);
  }

  console.log('✅ 同步完成');
  console.log('');
  console.log('最新提交:');
  const lg = await runGit(['log', '--oneline', '-3']);
  console.log(lg.out.trim());
  console.log('');
  console.log('本地未提交改动:');
  const st = await runGit(['status', '--short']);
  console.log(st.out.trim() || '（无）');

  // 5) 内容树整理：扁平仓库（已含线上最新）→ content/
  if (contentReady) {
    console.log('');
    if (prePending.length) {
      console.log(`⚠️ content/ 有 ${prePending.length} 处未发布的本地位移，已跳过自动整理，避免覆盖。`);
      console.log(`   请先 node publish.js 发布（或处理），再重新同步。涉及：${prePending.slice(0, 8).join('、')}${prePending.length > 8 ? ' …' : ''}`);
    } else {
      const r = contentSync.refreshContentFromFlat(REPO_DIR, CONTENT_DIR, REPO_DIR);
      if (r.added || r.updated) {
        console.log(`✅ 内容树已整理: 新增 ${r.added}，更新 ${r.updated}`);
      } else {
        console.log('内容树与扁平一致（无需整理）');
      }
      if (r.skippedDelete) {
        console.log(`⚠️ content/ 缺少 ${r.skippedDelete} 个已同步页面，未自动恢复；`);
        console.log(`   如为有意删除请走发布流程，如误删请: node bin/content-sync.js mirror`);
      }
    }
  } else {
    console.log('');
    console.log('（content/ 不存在，跳过内容树整理；可先 node bin/content-sync.js mirror 初始化）');
  }
}

main();
