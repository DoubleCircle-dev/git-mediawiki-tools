#!/usr/bin/env node
/**
 * 设置/更新 git-mediawiki 远程的登录密码（终端输入回显 *）
 * 用法: node set-pass.js [用户名]
 * 说明: 凭据写入扁平仓库 .git/config 的 remote.<remote>.mwlogin/mwpassword；
 *       用户名缺省取 config.json 的 defaultUser，仍缺省则沿用已配置的 mwlogin。
 */
'use strict';

const { spawn, execSync } = require('child_process');
const path = require('path');

const cfg = require('../lib/config.js').load();
const REPO_DIR = cfg.wikiRepo;
const REMOTE = cfg.remote;

let username = process.argv[2] || cfg.defaultUser || '';
if (!username) {
  try {
    username = execSync(
      `git config --get remote.${REMOTE}.mwlogin`, { cwd: REPO_DIR }
    ).toString().trim();
  } catch (e) { /* 尚未配置过，稍后交互输入 */ }
}

function runGitConfig(name, value) {
  return new Promise((resolve, reject) => {
    const p = spawn('git', ['config', `remote.${REMOTE}.${name}`, value], { cwd: REPO_DIR });
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`git config ${name} 失败`))));
  });
}

// 隐藏输入密码（回显 *，支持退格）
function readPassword(prompt) {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    let pass = '';
    process.stdin.on('data', (chunk) => {
      for (const ch of chunk) {
        if (ch === 13 || ch === 10) { // Enter
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdout.write('\n');
          resolve(pass);
          return;
        } else if (ch === 3) { // Ctrl+C
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdout.write('^C\n');
          process.exit(1);
        } else if (ch === 127 || ch === 8) { // Backspace
          if (pass.length > 0) {
            pass = pass.slice(0, -1);
            process.stdout.write('\b \b');
          }
        } else {
          pass += String.fromCharCode(ch);
          process.stdout.write('*');
        }
      }
    });
  });
}

async function main() {
  if (!username) {
    console.error('❌ 未指定用户名：用法 node set-pass.js <用户名>，或在 config.json 设置 defaultUser');
    process.exit(1);
  }
  const label = cfg.wikiName || REMOTE;
  const pass = await readPassword(`请输入 ${label} 密码 (用户 ${username}): `);
  try {
    await runGitConfig('mwLogin', username);
    await runGitConfig('mwPassword', pass);
    console.log(`✅ 凭据已写入扁平仓库 .git/config 的 remote.${REMOTE}（建议保持 600 权限）`);
  } catch (e) {
    console.error('❌ 设置失败:', e.message);
    process.exit(1);
  }
}

main();
