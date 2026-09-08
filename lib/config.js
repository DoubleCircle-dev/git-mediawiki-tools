'use strict';
/**
 * git-mediawiki 工具集：配置加载层
 *
 * 配置来源（优先级从高到低）：
 *   1. 环境变量 GWMW_CONFIG 指向的 JSON 文件
 *   2. 仓库根目录下的 config.json
 *   3. 内置默认值（单远程 origin，标准命名空间集）
 *
 * 单值覆盖：环境变量 GWMW_REMOTE 可覆盖 remote / pushOrder（用逗号分隔多个）。
 *
 * 用法：
 *   const cfg = require('../lib/config.js').load();
 */
const fs = require('fs');
const path = require('path');

const APP_ROOT = path.join(__dirname, '..');

// 通用默认命名空间集（标准 MediaWiki 命名空间，不含主命名空间与 File 图片）。
// 你的 wiki 若启用了扩展命名空间（如 Widget/Module 之外的自定义命名空间），
// 请在 config.json 的 namespaces 里补齐。
const DEFAULT_NAMESPACES = [
  'Talk', 'User', 'User_talk',
  'Project', 'Project_talk',
  'File', 'File_talk',
  'MediaWiki', 'MediaWiki_talk',
  'Template', 'Template_talk',
  'Help', 'Help_talk',
  'Category', 'Category_talk',
  'Widget', 'Widget_talk',
  'Module', 'Module_talk',
];

const DEFAULTS = {
  wikiName: 'mywiki',
  remote: 'origin',
  pushOrder: ['origin'],
  wikiRepo: 'wiki.mywiki',
  contentDir: 'content',
  namespaces: DEFAULT_NAMESPACES,
  defaultUser: '',
  jsonContentModels: false,
  timeoutMs: 180000,
  // 本地预览（可选）——见 bin/preview.js 与 config.example.json
  preview: {
    enabled: false,        // 需要本地 MediaWiki 安装目录时才启用
    mediawikiDir: '',      // 本地 MediaWiki 安装目录（php 环境）
    phpBin: 'php',         // php 可执行
    port: 8080,            // php -S 端口
    adminUser: 'Admin',    // 导入到本地预览所用的用户
    importSummary: '本地同步', // 导入编辑摘要
    dbFile: '',            // 主 SQLite（退出精简用；留空则跳过精简）
    imageStage: '',        // 图片导入暂存目录（留空用系统临时目录）
    noBackfill: false,     // true 则保存 content .mw 时不回写扁平仓库
  },
};

function abs(root, p) {
  return path.isAbsolute(p) ? p : path.join(root, p);
}

function load() {
  // 1) 配置文件定位
  let cfgPath = process.env.GWMW_CONFIG;
  if (!cfgPath) {
    const local = path.join(APP_ROOT, 'config.json');
    if (fs.existsSync(local)) cfgPath = local;
  }
  const fileCfg = cfgPath && fs.existsSync(cfgPath)
    ? JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
    : {};

  const cfg = { ...DEFAULTS, ...fileCfg };

  // 2) 环境变量覆盖 remote
  if (process.env.GWMW_REMOTE) {
    cfg.remote = process.env.GWMW_REMOTE.split(',')[0];
    cfg.pushOrder = process.env.GWMW_REMOTE.split(',').map((s) => s.trim()).filter(Boolean);
  }

  // 3) 规范化路径为绝对路径（相对仓库根）
  cfg.appRoot = APP_ROOT;
  cfg.wikiRepo = abs(APP_ROOT, cfg.wikiRepo);
  cfg.contentDir = abs(APP_ROOT, cfg.contentDir);
  // 4) 预览段合并默认并按需解析绝对路径
  cfg.preview = { ...DEFAULTS.preview, ...(cfg.preview || {}) };
  if (cfg.preview.mediawikiDir) cfg.preview.mediawikiDir = abs(APP_ROOT, cfg.preview.mediawikiDir);
  if (cfg.preview.dbFile) cfg.preview.dbFile = abs(APP_ROOT, cfg.preview.dbFile);
  if (cfg.apiUrl === undefined) {
    // 若未显式给 apiUrl 且给了 wikiBaseUrl，则默认 <base>api.php
    if (cfg.wikiBaseUrl) cfg.apiUrl = String(cfg.wikiBaseUrl).replace(/\/+$/, '') + '/api.php';
  }
  cfg.namespaces = (cfg.namespaces || []).map(String);
  return cfg;
}

module.exports = { load, APP_ROOT, DEFAULTS, DEFAULT_NAMESPACES };
