'use strict';
/**
 * upload-media 核心模块：把本地媒体文件批量上传到 MediaWiki 远端。
 *
 * 背景：git-remote-mediawiki 的「推送媒体」路径在本机 Perl 下会崩
 *       （HTTP::Message content must be bytes），所以扁平仓库设了
 *       `remote.<remote>.mediaexport=false`，Git 侧只推 `.mw` 页面；
 *       二进制媒体改由本模块走 API 上传（`action=upload`）。
 *       两侧配合后，扁平仓库（页面）与 wiki（媒体）状态保持一致。
 *
 * 被两处使用：
 *   - bin/upload-media.js  命令行：手动/脚本化批量上传
 *   - bin/publish.js       发布收尾：best-effort 上传，失败只提示原因，
 *                          不影响（也不回滚）已经完成的页面推送
 *
 * 零第三方依赖（Node 18+ 内置 fetch / FormData / Blob）。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { load } = require('./config.js');

const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.pdf'];

/** 只有超过这个体积（10MB）才提示「先压缩」；
 *  不超过的直接传，失败时按「忽略警告」再试一次（瞬时拒绝/抖动常能救回）。 */
const COMPRESS_OVER_BYTES = 10 * 1024 * 1024;

function isMedia(name) {
  const ext = path.extname(String(name)).toLowerCase();
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

function sizeLabel(p) {
  try {
    return `${(fs.statSync(p).size / 1024).toFixed(0)}K`;
  } catch (e) {
    return '?';
  }
}

// ---------------------------------------------------------------------------
// 失败原因解释：把 API 返回 / 异常文本映射成可操作的提示
// ---------------------------------------------------------------------------
function explainFailure(why, { sizeBytes = 0, compressOverBytes = COMPRESS_OVER_BYTES } = {}) {
  const s = String(why || '');
  const mb = (n) => `${(n / 1048576).toFixed(1)}MB`;
  const compressHint = '先压缩再传：'
    + 'ffmpeg -i in.png -vf "palettegen=max_colors=256:stats_mode=diff" pal.png'
    + ' && ffmpeg -i in.png -i pal.png -lavfi "paletteuse=dither=sierra2_4a" out.png';
  if (/badupload-inisize|upload_max_filesize|iniserver size limit|exceeds.*size/i.test(s)) {
    if (sizeBytes > compressOverBytes) {
      return `文件 ${mb(sizeBytes)} 超过 ${mb(compressOverBytes)} 阈值 → ${compressHint}`;
    }
    return `未超过 ${mb(compressOverBytes)} 仍被服务端拒绝（已按「忽略警告」重试过）→`
      + '检查线上 PHP upload_max_filesize / 账号上传权限，或稍后重试';
  }
  if (/duplicate|exists|warning.*exists/i.test(s)) {
    return '远端已有同名文件且内容不同（同名不同内容）→ 用 overwrite 重传或改媒体文件名';
  }
  if (/ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|fetch failed|Can't connect|Temporary failure in name resolution/i.test(s)) {
    return 'DNS / 网络抖动（本站经 Cloudflare，偶发解析失败）→ 稍后重试即可';
  }
  if (/ratelimited|too many/i.test(s)) {
    return '服务端限流 → 稍等片刻后重试';
  }
  if (/badaccess|permissiondenied|readapidenied|mustbeloggedin/i.test(s)) {
    return '账号无上传/登录权限 → 检查凭据与账号权限（node bin/set-pass.js <用户名>）';
  }
  if (/登录失败|logintoken|lgpassword|WrongPass/i.test(s)) {
    return '登录失败 → 凭据可能已过期，重跑 node bin/set-pass.js <用户名>';
  }
  return '';
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
   *  键按「下划线转空格 + 首字母大写」归一，避免 API 用下划线存名导致误判缺失。 */
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
    if (up.result !== 'Success') {
      const warns = up.warnings ? Object.keys(up.warnings).join(',') : '';
      return { ok: false, why: `${up.result || '未知'}${warns ? ` (${warns})` : ''}` };
    }
    return { ok: true, result: up.result, warnings: up.warnings ? Object.keys(up.warnings) : [] };
  }
}

// ---------------------------------------------------------------------------
/**
 * 批量上传媒体（核心）。
 *
 * @param {object} [opts]
 * @param {string[]} [opts.files]   只处理指定文件（路径或媒体名）；默认扫描目录
 * @param {boolean}  [opts.all]     忽略差异，全部重传
 * @param {boolean}  [opts.dryRun]  只列清单，不实际上传
 * @param {boolean}  [opts.flat]    改为扫描扁平仓库根目录（默认扫 content/images）
 * @param {object}   [opts.cfg]     配置对象（默认 load()）
 * @param {string}   [opts.comment] 上传注释
 * @param {boolean}  [opts.header]  是否打印「媒体批量上传 → URL」表头（默认 true）
 * @param {function} [opts.log]     进度输出（默认静默）
 *
 * @returns {Promise<object>} 永不抛出：
 *   { ok, fatal?, url, user, remoteCount, candidates,
 *     uploaded:[{name,size,warnings}], skipped:[{name,size}],
 *     pending:[{name,size,why}], failed:[{name,size,why,hint}], missing:[name] }
 */
async function syncMedia(opts = {}) {
  const {
    files = [], all = false, dryRun = false, flat = false,
    cfg = load(), comment = '批量上传媒体（upload-media）', header = true, log = () => {},
    compressOverBytes = COMPRESS_OVER_BYTES, retryOnce = true,
  } = opts;

  const repo = cfg.wikiRepo;
  const remote = cfg.remote || 'origin';
  const base = String(cfg.apiUrl || gitConfig(repo, `remote.${remote}.url`).replace(/^mediawiki::/, '') || '');
  const url = base.endsWith('api.php') ? base : `${base}api.php`;
  const empty = {
    ok: false, fatal: null, url, user: '', remoteCount: 0,
    candidates: 0, uploaded: [], skipped: [], pending: [], failed: [], missing: [],
  };

  if (!base) {
    return { ...empty, fatal: { code: 'no-api-url', message: `无法确定 API 地址（config.apiUrl 为空，且 ${remote} 不是 mediawiki 远程）`, hint: '在 config.json 里设置 apiUrl，例如 https://wiki.example.org/api.php' } };
  }

  const user = gitConfig(repo, `remote.${remote}.mwLogin`);
  const pass = gitConfig(repo, `remote.${remote}.mwPassword`);
  if (!user || !pass) {
    return { ...empty, fatal: { code: 'no-credentials', message: `未取到凭据：git -C ${repo} config remote.${remote}.mwLogin/mwPassword`, hint: '先跑 node bin/set-pass.js <用户名> 写入凭据' } };
  }

  // 候选文件
  const candidates = [];
  const missing = [];
  if (files.length) {
    for (const f of files) {
      const p = fs.existsSync(f) ? f : path.join(cfg.contentDir || '', 'images', f);
      if (fs.existsSync(p) && fs.statSync(p).isFile()) candidates.push(p);
      else if (fs.existsSync(path.join(repo, f))) candidates.push(path.join(repo, f));
      else missing.push(f);
    }
  } else {
    const dir = flat ? repo : path.join(cfg.contentDir || '', 'images');
    if (!fs.existsSync(dir)) {
      return { ...empty, fatal: { code: 'no-dir', message: `目录不存在: ${dir}`, hint: '把图片放进 content/images/，或用 --flat 扫描扁平仓库根目录' } };
    }
    for (const n of fs.readdirSync(dir)) {
      if (isMedia(n) && fs.statSync(path.join(dir, n)).isFile()) candidates.push(path.join(dir, n));
    }
  }
  candidates.sort();

  const api = new Api(url);
  let remoteCount = 0;
  let remoteMedia;
  try {
    if (header) log(`===== 媒体批量上传 → ${url.replace(/\/api\.php$/, '')} =====`);
    const who = await api.login(user, pass);
    log(`   登录: ${who}`);
    remoteMedia = await api.remoteMedia();
    remoteCount = remoteMedia.size;
    log(`   远端现有文件: ${remoteCount} 个\n`);
  } catch (e) {
    return {
      ...empty, user, candidates: candidates.length, missing,
      fatal: {
        code: 'connect-failed',
        message: `登录/连接失败：${e.message}`,
        hint: explainFailure(e.message) || '检查网络与凭据后重试',
      },
    };
  }

  const out = {
    ...empty, ok: true, user, remoteCount,
    candidates: candidates.length, missing,
  };

  for (const p of candidates) {
    const name = path.basename(p);
    const size = sizeLabel(p);
    const local = sha1File(p);
    const remoteSha1 = remoteMedia.get(normName(name)) || null;

    if (!all && remoteSha1 === local) {
      out.skipped.push({ name, size });
      log(`  ✓ 已存在且一致，跳过  ${name} (${size})`);
      continue;
    }
    if (dryRun) {
      const why = remoteSha1 ? '内容不同' : '远端缺失';
      out.pending.push({ name, size, why });
      log(`  → 待上传  ${name} (${size})${remoteSha1 ? ' [内容不同]' : ' [远端缺失]'}`);
      continue;
    }
    const buf = fs.readFileSync(p);
    const sizeBytes = buf.length;
    let res;
    try {
      res = await api.upload(name, buf, { comment });
    } catch (e) {
      res = { ok: false, why: e.message };
    }
    // 未超阈值的失败再试一次（等价于「忽略警告重试」）：
    // 服务端以警告拒绝（exists / duplicate 等）或瞬时抖动，常能被第二次救回；
    // 超过阈值的则不再纠缠，直接提示先压缩。
    let retried = false;
    if (!res.ok && retryOnce && sizeBytes <= compressOverBytes) {
      retried = true;
      try {
        res = await api.upload(name, buf, { comment });
      } catch (e) {
        res = { ok: false, why: e.message };
      }
    }
    if (res.ok) {
      out.uploaded.push({ name, size, warnings: res.warnings, retried });
      log(`  ⬆ 已上传  ${name} (${size})${retried ? '（忽略警告重试后成功）' : ''}`
        + `${res.warnings.length ? '  警告:' + res.warnings.join(',') : ''}`);
    } else {
      const hint = explainFailure(res.why, { sizeBytes, compressOverBytes });
      out.failed.push({ name, size, why: res.why, hint, retried });
      log(`  ✗ 失败    ${name} (${size})${retried ? '（已尝试忽略警告重试）' : ''}  ${res.why}`
        + `${hint ? `\n      ↳ ${hint}` : ''}`);
    }
  }

  log(`\n合计: 上传 ${out.uploaded.length}，跳过 ${out.skipped.length}`
    + (out.pending.length ? `，待上传 ${out.pending.length}` : '')
    + `，失败 ${out.failed.length}`);
  return out;
}

/**
 * 把 syncMedia 的结果转成「发布收尾 best-effort」的提示行（纯函数，便于测试）。
 * 原则：无论失败原因是什么，都只输出提示，绝不能阻断/回滚已完成的页面推送。
 * @param {object} r syncMedia() 的返回值
 * @returns {string[]} 待打印的行
 */
function formatBestEffort(r) {
  const out = [];
  if (!r || !r.ok) {
    out.push(`⚠️ 媒体上传未执行（页面推送已完成）：${(r && r.fatal && r.fatal.message) || '未知原因'}`);
    if (r && r.fatal && r.fatal.hint) out.push(`   ↳ ${r.fatal.hint}`);
    out.push('   ↳ 修好后单独重跑：node bin/upload-media.js');
    return out;
  }
  if (r.failed.length) {
    out.push(`⚠️ ${r.failed.length} 个媒体上传失败（不影响页面推送）：`);
    for (const f of r.failed) {
      out.push(`   ✗ ${f.name} (${f.size})  ${f.why}${f.retried ? '（已忽略警告重试仍未成功）' : ''}`);
      if (f.hint) out.push(`      ↳ ${f.hint}`);
    }
    out.push('   ↳ 处理后单独重跑（只补差异）：node bin/upload-media.js');
  } else if (r.uploaded.length) {
    out.push(`媒体已上传 ${r.uploaded.length} 个（远端现有 ${r.remoteCount} 个文件）`);
  }
  return out;
}

module.exports = {
  syncMedia, explainFailure, formatBestEffort, COMPRESS_OVER_BYTES,
  isMedia, normName, sha1File, gitConfig, Api, IMAGE_EXTS,
};
