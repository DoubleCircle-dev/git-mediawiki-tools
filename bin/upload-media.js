#!/usr/bin/env node
/**
 * upload-media.js —— 把本地媒体文件批量上传到 MediaWiki 远端（命令行入口）
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
 * 说明: 核心逻辑在 lib/upload-media.js；bin/publish.js 发布收尾也会 best-effort 调用它。
 *
 * 零第三方依赖（Node 18+ 内置 fetch/FormData/Blob）。
 */
'use strict';

const { syncMedia } = require('../lib/upload-media.js');

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
  const { files, opts } = parseArgs(process.argv.slice(2));
  const r = await syncMedia({
    files, all: opts.all, dryRun: opts.dryRun, flat: opts.flat,
    log: (s) => console.log(s),
  });

  if (!r.ok) {
    console.error(`❌ ${r.fatal.message}`);
    if (r.fatal.hint) console.error(`   ↳ ${r.fatal.hint}`);
    process.exit(1);
  }

  for (const m of r.missing) console.log(`  ⚠️ 跳过（未找到）: ${m}`);
  if (r.failed.length) process.exitCode = 1;
}

main().catch((e) => { console.error('❌', e.message); process.exit(1); });
