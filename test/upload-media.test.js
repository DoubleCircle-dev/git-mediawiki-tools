'use strict';
/**
 * upload-media 模块测试（零依赖：node:test + node:assert）
 *
 * 重点保证「媒体上传失败必须可解释、且不抛异常」——它是 publish 收尾 best-effort
 * 步骤的前提：任何失败都只能变成提示，不能影响已完成的页面推送。
 *
 *   ① explainFailure：把常见 API / 网络错误文本翻译成可操作提示
 *   ② 缺凭据 / 目录不存在 / 找不到 API 地址 → 返回 { ok:false, fatal:{code,message,hint} }，不抛
 *   ③ 媒体名归一（API 用下划线存名，本地是空格）
 *
 * 全程离线（只跑会提前返回的分支，不请求任何真实站点）。
 * 运行：npm test
 */
const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const LIB = require('../lib/upload-media.js');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'um-test-'));

/** 造一个临时 git 仓库当作「扁平仓库」（可选写入凭据） */
function makeRepo({ withCreds = true } = {}) {
  const dir = fs.mkdtempSync(path.join(ROOT, 'repo-'));
  execFileSync('git', ['init', '-q', '-b', 'master'], { cwd: dir });
  if (withCreds) {
    execFileSync('git', ['config', 'remote.origin.mwlogin', 'Tester'], { cwd: dir });
    execFileSync('git', ['config', 'remote.origin.mwpassword', 'secret'], { cwd: dir });
  }
  return dir;
}

function cfgOf(repo, contentDir) {
  return {
    wikiRepo: repo,
    contentDir,
    remote: 'origin',
    apiUrl: 'https://wiki.example.invalid/api.php',
  };
}

test('explainFailure：常见失败文本都能给出可操作提示', () => {
  assert.match(
    LIB.explainFailure('paramvalidator-badupload-inisize: The file is bigger than the maximum size'),
    /upload_max_filesize/);
  assert.match(LIB.explainFailure('fetch failed'), /网络/);
  assert.match(LIB.explainFailure('ratelimited: too many requests'), /重试/);
  assert.match(LIB.explainFailure('登录失败: WrongPass'), /set-pass/);
  assert.match(LIB.explainFailure('Warning: exists'), /同名/);
  assert.strictEqual(LIB.explainFailure('某个没见过的错误'), '');
});

test('缺凭据 → fatal.no-credentials（返回而非抛出，供 publish 提示后跳过）', async () => {
  const repo = makeRepo({ withCreds: false });
  const r = await LIB.syncMedia({ cfg: cfgOf(repo, path.join(repo, 'content')) });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.fatal.code, 'no-credentials');
  assert.match(r.fatal.message, /mwLogin/);
  assert.ok(r.fatal.hint, '应给出可操作提示');
});

test('图片目录不存在 → fatal.no-dir', async () => {
  const repo = makeRepo();
  const r = await LIB.syncMedia({ cfg: cfgOf(repo, path.join(repo, 'no-such-content')) });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.fatal.code, 'no-dir');
  assert.match(r.fatal.hint, /content\/images|--flat/);
});

test('既无 apiUrl、远程也不是 mediawiki → fatal.no-api-url', async () => {
  const repo = makeRepo();
  const r = await LIB.syncMedia({
    cfg: { wikiRepo: repo, contentDir: path.join(repo, 'content'), remote: 'origin' },
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.fatal.code, 'no-api-url');
});

test('媒体名归一：API 的下划线名与本地空格名可比对', () => {
  assert.strictEqual(LIB.normName('9on0_System.png'), '9on0 System.png');
  assert.strictEqual(LIB.normName('foo_bar.jpg'), 'Foo bar.jpg');
  assert.strictEqual(LIB.normName('  已压缩.png '), '已压缩.png');
});

test('explainFailure：只有超过 10MB 才提示压缩，否则按「忽略警告」处理', () => {
  const why = 'paramvalidator-badupload-inisize: The file is bigger than the maximum size';

  const small = LIB.explainFailure(why, { sizeBytes: 3 * 1024 * 1024 });
  assert.doesNotMatch(small, /ffmpeg/, '未超阈值不应提示压缩');
  assert.match(small, /忽略警告/);

  const big = LIB.explainFailure(why, { sizeBytes: 11 * 1024 * 1024 });
  assert.match(big, /ffmpeg/);
  assert.match(big, /11\.0MB/);
  assert.match(big, /10\.0MB/);
});

test('未超 10MB 的上传失败会忽略警告重试一次（重试成功计入已上传）', async () => {
  const http = require('node:http');
  let uploads = 0;
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      let payload;
      if (req.url.includes('meta=tokens')) {
        payload = { query: { tokens: { logintoken: 'lt', csrftoken: 'ct' } } };
      } else if (body.includes('action=login')) {
        payload = { login: { result: 'Success', lgusername: 'Tester' } };
      } else if (req.url.includes('list=allimages')) {
        payload = { query: { allimages: [] } };
      } else {
        uploads += 1;
        // 第一次用「警告」拒绝（模拟 exists 之类），第二次成功
        payload = uploads === 1
          ? { upload: { result: 'Warning', warnings: { exists: {} } } }
          : { upload: { result: 'Success' } };
      }
      res.end(JSON.stringify(payload));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  try {
    const repo = makeRepo();
    const content = path.join(repo, 'content');
    fs.mkdirSync(path.join(content, 'images'), { recursive: true });
    fs.writeFileSync(path.join(content, 'images', 'shot.png'), Buffer.from('not-a-real-png'));

    const r = await LIB.syncMedia({
      cfg: {
        wikiRepo: repo,
        contentDir: content,
        remote: 'origin',
        apiUrl: `http://127.0.0.1:${port}/api.php`,
      },
      log: () => {},
    });

    assert.strictEqual(r.ok, true);
    assert.strictEqual(uploads, 2, '应恰好重试一次');
    assert.strictEqual(r.uploaded.length, 1);
    assert.strictEqual(r.uploaded[0].retried, true, '应记录为重试后成功');
    assert.strictEqual(r.failed.length, 0);
  } finally {
    srv.close();
  }
});

test('isMedia：只认图片/PDF 扩展名', () => {
  assert.ok(LIB.isMedia('a.png'));
  assert.ok(LIB.isMedia('a.JPEG'));
  assert.ok(LIB.isMedia('a.pdf'));
  assert.ok(!LIB.isMedia('a.mw'));
  assert.ok(!LIB.isMedia('a.txt'));
});

test('formatBestEffort：整体无法执行时给出原因 + hint + 重跑命令', () => {
  const lines = LIB.formatBestEffort({
    ok: false,
    fatal: { code: 'connect-failed', message: '登录/连接失败：fetch failed', hint: 'DNS / 网络抖动 → 稍后重试' },
  }).join('\n');
  assert.match(lines, /页面推送已完成/);
  assert.match(lines, /fetch failed/);
  assert.match(lines, /网络抖动/);
  assert.match(lines, /node bin\/upload-media\.js/);
});

test('formatBestEffort：部分文件失败时逐项给原因，并声明不影响推送', () => {
  const lines = LIB.formatBestEffort({
    ok: true,
    remoteCount: 49,
    uploaded: [],
    skipped: [],
    failed: [{
      name: 'big.png',
      size: '3M',
      why: 'paramvalidator-badupload-inisize: The file is bigger than the maximum size',
      hint: LIB.explainFailure('paramvalidator-badupload-inisize'),
    }],
  }).join('\n');
  assert.match(lines, /不影响页面推送/);
  assert.match(lines, /big\.png \(3M\)/);
  assert.match(lines, /badupload-inisize/);
  assert.match(lines, /upload_max_filesize/);
});

test('formatBestEffort：全部成功时只报数量', () => {
  const lines = LIB.formatBestEffort({
    ok: true, remoteCount: 49, uploaded: [{ name: 'a.png' }], skipped: [], failed: [],
  });
  assert.strictEqual(lines.length, 1);
  assert.match(lines[0], /媒体已上传 1 个/);
});

after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
