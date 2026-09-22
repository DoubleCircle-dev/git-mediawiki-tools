#!/usr/bin/env node
/**
 * upload-media.js —— 把本地媒体文件批量上传到 MediaWiki 远端
 *
 * 背景：git-remote-mediawiki 的「推送媒体」路径在本机 Perl 下会崩
 *       （HTTP::Message content must be bytes），所以媒体改由本工具走 API 上传，
 *       git 侧只管页面。两者配合后，扁平仓库与 wiki 状态保持一致。
 *
 * 用法:
 *   node bin/upload-media.js                     # 扫描 content/images，上传远端缺失/不一致的
 *   node bin/upload-media.js <文件|名字> ...      # 只处理指定文件（可给路径或媒体名）
 *   node bin/upload-media.js --all               # 忽略差异，全部重传
 *   node bin/upload-media.js --dry-run           # 只列出将要上传的，不实际传
 *   node bin/upload-media.js --flat              # 改为扫描扁平仓库根目录下的媒体
 *
 * 凭据: 取扁平仓库 git config 的 remote.<remote>.mwLogin / mwPassword（不打印）。
 * 配置: 与其它工具同源，读 git-mediawiki-tools/config.json。
 *
 * 零第三方依赖（Node 18+ 内置 fetch/FormData/Blob）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { load } = require('../lib/config.js');

const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.pdf'];

function isMedia(name) {
  const ext = path.extname(name).toLowerCase();
  return IMAGE_EXTS.includes(ext);
}

/** 媒体名归一：下划线→空格、去首尾空白、首字母大写，用于跨端比对 */
function normName(name) {
  let n = String(name).replace(/_/g, ' ').trim();
  if (!n) return '';
  return n[0].toUpperCase() + n.slice(1);
}

function sha1File(p) {
  return crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex');
}

function gitConfig(repo, key) {
  try {
    return execFileSync('git', ['-C', repo, 'config', '--get', key], { encoding: 'utf8' }).trim();
  } catch (e) {
    return '';
  }
}

// ---------------------------------------------------------------------------
// MediaWiki API（带 Cookie 的 GET/POST）
// ---------------------------------------------------------------------------
class Api {
  constructor(url, ua) {
    this.url = url;
    this.ua = ua || 'git-mediawiki-tools/upload-media';
    this.cookie = '';
  }

  async raw(params, form) {
    const headers = { 'User-Agent': this.ua };
    if (this.cookie) headers.Cookie = this.cookie;
    let res;
    if (form) {
      res = await fetch(this.url, { method: 'POST', headers, body: form });
    } else {
      const qs = new URLSearchParams(params).toString();
      res = await fetch(`${this.url}?${qs}`, { method: 'GET', headers });
    }
    const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    if (sc.length) {
      const jar = new Map();
      for (const c of this.cookie ? this.cookie.split('; ') : []) {
        const i = c.indexOf('=');
        if (i > 0) jar.set(c.slice(0, i), c.slice(i + 1));
      }
      for (const c of sc) {
        const kv = c.split(';')[0];
        const i = kv.indexOf('=');
        if (i > 0) jar.set(kv.slice(0, i), kv.slice(i + 1));
      }
      this.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    }
    return res.json();
  }

  get(params) {
    return this.raw({ ...params, format: 'json' });
  }

  async login(user, pass) {
    const t = await this.get({ action: 'query', meta: 'tokens', type: 'login' });
    const token = t.query.tokens.logintoken;
    const body = new URLSearchParams({
      action: 'login', lgname: user, lgpassword: pass, lgtoken: token, format: 'json',
    });
    const r = await this.raw(null, body);
    const result = r.login && r.login.result;
    if (result !== 'Success') throw new Error(`登录失败: ${result || JSON.stringify(r).slice(0, 200)}`);
    return r.login.lgusername || r.login.username || user;
  }

  async csrfToken() {
    const r = await this.get({ action: 'query', meta: 'tokens', type: 'csrf' });
    return r.query.tokens.csrftoken;
  }

  /** 远端现存文件的 sha1 映射（媒体名 -> sha1）；分页取全量。
   *  键按「下划线转空格 + 首字母大写 + 小写比较」归一，避免 API 用下划线存名导致误判缺失。 */
  async remoteMedia() {
    const out = new Map();
    let cont = null;
    do {
      const params = {
        action: 'query', list: 'allimages', ailimit: '500',
        aiprop: 'sha1|url', format: 'json',
      };
      if (cont) params.aicontinue = cont;
      const r = await this.get(params);
      for (const it of r.query.allimages) out.set(normName(it.name), it.sha1);
      cont = r.continue && r.continue.aicontinue;
    } while (cont);
    return out;
  }

  /** 单个文件远端 sha1；不存在返回 null */
  async remoteSha1(name) {
    const r = await this.get({
      action: 'query', titles: `File:${name}`, prop: 'imageinfo',
      iiprop: 'sha1', format: 'json',
    });
    const pages = r.query && r.query.pages;
    if (!pages) return null;
    for (const k of Object.keys(pages)) {
      const p = pages[k];
      if (p.missing !== undefined) return null;
      if (p.imageinfo && p.imageinfo[0]) return p.imageinfo[0].sha1;
    }
    return null;
  }

  async upload(name, buf, { comment, ignoreWarnings = true } = {}) {
    const token = await this.csrfToken();
    const form = new FormData();
    form.set('action', 'upload');
    form.set('filename', name);
    form.set('token', token);
    form.set('format', 'json');
    if (comment) form.set('comment', comment);
    if (ignoreWarnings) form.set('ignorewarnings', '1');
    form.set('file', new Blob([buf]), name);
    const r = await this.raw(null, form);
    if (r.error) return { ok: false, why: `${r.error.code}: ${r.error.info}` };
    const up = r.upload || {};
    if (up.result !== 'Success') return { ok: false, why: `${up.result || '未知'}: ${up.warnings ? Object.keys(up.warnings).join(',') : ''}` };
    return { ok: true, result: up.result, warnings: up.warnings ? Object.keys(up.warnings) : [] };
  }
}

// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const files = [];
  const opts = { all: false, dryRun: false, flat: false };
  for (const a of argv) {
    if (a === '--all') opts.all = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--flat') opts.flat = true;
    else files.push(a);
  }
  return { files, opts };
}

async function main() {
  const cfg = load();
  const repo = cfg.wikiRepo;
  const remote = cfg.remote || 'origin';
  const url = cfg.apiUrl || gitConfig(repo, `remote.${remote}.url`).replace(/^mediawiki::/, '') + 'api.php';
  const user = gitConfig(repo, `remote.${remote}.mwLogin`);
  const pass = gitConfig(repo, `remote.${remote}.mwPassword`);
  if (!user || !pass) {
    console.error(`❌ 未取到凭据：git -C ${repo} config remote.${remote}.mwLogin/mwPassword`);
    process.exit(1);
  }

  const { files, opts } = parseArgs(process.argv.slice(2));

  // 确定候选文件
  let candidates = [];
  if (files.length) {
    for (const f of files) {
      const p = fs.existsSync(f) ? f : path.join(cfg.contentDir || '', 'images', f);
      if (fs.existsSync(p) && fs.statSync(p).isFile()) candidates.push(p);
      else if (fs.existsSync(path.join(repo, f))) candidates.push(path.join(repo, f));
      else console.log(`  ⚠️ 跳过（未找到）: ${f}`);
    }
  } else {
    const dir = opts.flat ? repo : path.join(cfg.contentDir || '', 'images');
    if (!fs.existsSync(dir)) { console.error(`❌ 目录不存在: ${dir}`); process.exit(1); }
    candidates = fs.readdirSync(dir)
      .filter(n => isMedia(n) && fs.statSync(path.join(dir, n)).isFile())
      .map(n => path.join(dir, n));
  }
  candidates.sort();

  const api = new Api(url);
  console.log(`===== 媒体批量上传 → ${url.replace(/\/api\.php$/, '')} =====`);
  console.log(`   登录: ${await api.login(user, pass)}`);
  const remoteMedia = await api.remoteMedia();
  console.log(`   远端现有文件: ${remoteMedia.size} 个\n`);

  let up = 0, skip = 0, fail = 0;
  for (const p of candidates) {
    const name = path.basename(p);
    const local = sha1File(p);
    const remoteSha1 = remoteMedia.get(normName(name)) || null;
    const size = (fs.statSync(p).size / 1024).toFixed(0) + 'K';

    if (!opts.all && remoteSha1 === local) {
      console.log(`  ✓ 已存在且一致，跳过  ${name} (${size})`);
      skip++; continue;
    }
    if (opts.dryRun) {
      console.log(`  → 待上传  ${name} (${size})${remoteSha1 ? ' [内容不同]' : ' [远端缺失]'}`);
      up++; continue;
    }
    const res = await api.upload(name, fs.readFileSync(p), { comment: '批量上传媒体（upload-media）' });
    if (res.ok) {
      console.log(`  ⬆ 已上传  ${name} (${size})${res.warnings.length ? '  警告:' + res.warnings.join(',') : ''}`);
      up++;
    } else {
      console.log(`  ✗ 失败    ${name} (${size})  ${res.why}`);
      fail++;
    }
  }
  console.log(`\n合计: 上传 ${up}，跳过 ${skip}，失败 ${fail}`);
  if (fail) process.exitCode = 1;
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
