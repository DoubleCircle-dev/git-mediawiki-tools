'use strict';
/*
 * publish.js 的「删除页面处置」单元测试：
 *   - resolveDeletion：按内容模型选模式，未列出的模型用 defaultMode，text 缺文本退回 helper
 *   - stubContentFor：各内容模型写「同格式注释占位」
 *   - config.js：deletion.modes 与内置默认逐模型合并（只覆盖 wikitext 时其余模型仍走内置）
 * 通过 GWMW_CONFIG 指向临时配置来驱动（配置只在加载时读一次，故每次重载模块）。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gwmw-deletion-'));
const CFG_FILE = path.join(TMP, 'config.json');
fs.mkdirSync(path.join(TMP, 'flat'), { recursive: true });
fs.mkdirSync(path.join(TMP, 'content'), { recursive: true });

// 写入给定 deletion 段并重新加载 publish.js（连带 config.js 一起清缓存）
function loadPublish(deletion) {
  fs.writeFileSync(CFG_FILE, JSON.stringify({
    wikiName: 'playground',
    wikiRepo: path.join(TMP, 'flat'),
    contentDir: path.join(TMP, 'content'),
    apiUrl: '',
    deletion,
  }, null, 2));
  process.env.GWMW_CONFIG = CFG_FILE;
  for (const m of ['../bin/publish.js', '../lib/config.js']) {
    delete require.cache[require.resolve(m)];
  }
  return require('../bin/publish.js');
}

const SITE_LIKE = {
  defaultMode: 'helper',
  modes: {
    wikitext: { mode: 'text', text: '{{需要删除}}' },
    Scribunto: 'stub',
    json: 'stub',
  },
};

test('resolveDeletion：modes 命中的模型按配置返回（对象与字符串两种写法）', () => {
  const pub = loadPublish(SITE_LIKE);
  assert.deepStrictEqual(pub.resolveDeletion('wikitext'), { mode: 'text', text: '{{需要删除}}' });
  assert.deepStrictEqual(pub.resolveDeletion('Scribunto'), { mode: 'stub', text: '' });
});

test('resolveDeletion：未列出的模型用 defaultMode（缺省 helper）', () => {
  const pub = loadPublish(SITE_LIKE);
  assert.deepStrictEqual(pub.resolveDeletion('sanitized-css'), { mode: 'stub', text: '' });  // 内置默认里就有
  assert.deepStrictEqual(pub.resolveDeletion('text'), { mode: 'helper', text: '' });          // 未列出
  assert.deepStrictEqual(pub.resolveDeletion('随便一个模型'), { mode: 'helper', text: '' });

  const noneDefault = loadPublish({ defaultMode: 'none', modes: {} });
  assert.deepStrictEqual(noneDefault.resolveDeletion('任意'), { mode: 'none', text: '' });
});

test('resolveDeletion：mode=text 但没给文本 → 退回 helper（不留空正文）', () => {
  const pub = loadPublish({ defaultMode: 'helper', text: '', modes: { wikitext: { mode: 'text' } } });
  assert.deepStrictEqual(pub.resolveDeletion('wikitext'), { mode: 'helper', text: '' });
});

test('resolveDeletion：文本可放在全局 deletion.text（供多模型共用）', () => {
  const pub = loadPublish({ defaultMode: 'helper', text: '{{需要删除}}', modes: { wikitext: 'text' } });
  assert.deepStrictEqual(pub.resolveDeletion('wikitext'), { mode: 'text', text: '{{需要删除}}' });
});

test('resolveDeletion：模式名非法时退回 defaultMode', () => {
  const pub = loadPublish({ defaultMode: 'stub', modes: { Scribunto: '随便写的模式' } });
  assert.deepStrictEqual(pub.resolveDeletion('Scribunto'), { mode: 'stub', text: '' });
});

test('stubContentFor：按内容模型写对应格式的注释占位', () => {
  const pub = loadPublish(SITE_LIKE);
  assert.strictEqual(pub.stubContentFor('Scribunto', 'note'), '-- note\n');
  assert.strictEqual(pub.stubContentFor('sanitized-css', 'note'), '/* note */\n');
  assert.strictEqual(pub.stubContentFor('css', 'note'), '/* note */\n');
  assert.strictEqual(pub.stubContentFor('less', 'note'), '/* note */\n');
  assert.strictEqual(pub.stubContentFor('javascript', 'note'), '// note\n');
  assert.strictEqual(pub.stubContentFor('json', 'note'), '{"_comment": "note"}\n');
  assert.strictEqual(pub.stubContentFor('wikitext', 'note'), null);   // 无对应格式 → 调用方改判 none
});

test('config：deletion.modes 与内置默认逐模型合并（只覆盖个别模型时其余仍生效）', () => {
  const pub = loadPublish({ modes: { wikitext: { mode: 'text', text: '{{需要删除}}' } } });
  assert.deepStrictEqual(pub.resolveDeletion('wikitext'), { mode: 'text', text: '{{需要删除}}' });
  assert.deepStrictEqual(pub.resolveDeletion('Scribunto'), { mode: 'stub', text: '' });      // 内置
  assert.deepStrictEqual(pub.resolveDeletion('javascript'), { mode: 'stub', text: '' });       // 内置
  assert.deepStrictEqual(pub.resolveDeletion('wikitext2'), { mode: 'helper', text: '' });      // defaultMode
});

test('config：未配置 deletion 段时保持旧行为（wikitext 交给 helper，脚本页占位）', () => {
  const pub = loadPublish(undefined);
  assert.deepStrictEqual(pub.resolveDeletion('wikitext'), { mode: 'helper', text: '' });
  assert.deepStrictEqual(pub.resolveDeletion('Scribunto'), { mode: 'stub', text: '' });
});

test('flatTitle / HELPER_DELETED 常量保持稳定', () => {
  const pub = loadPublish(SITE_LIKE);
  assert.strictEqual(pub.flatTitle('Template:%E9%9C%80%E8%A6%81%E5%88%A0%E9%99%A4.mw'), 'Template:需要删除');
  assert.strictEqual(pub.flatTitle('User_talk:A_B.mw'), 'User talk:A B');
  assert.strictEqual(pub.HELPER_DELETED, '[[Category:Deleted]]');
});
