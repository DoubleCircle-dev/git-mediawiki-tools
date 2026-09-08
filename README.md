# git-mediawiki-tools

用 Git 管理你的 MediaWiki 站点。基于 [Git-Mediawiki](https://github.com/Git-Mediawiki/Git-Mediawiki) 远程助手，把 wiki 当 Git 仓库同步 / 发布，并通过 **content/ 内容树**把扁平仓库整理成「按命名空间/子页面」的目录，便于人工浏览、编辑与审阅 diff。

## 特性

- **一键同步 / 发布**：`publish` 自动完成「内容树回写 → Git 提交 → 推送远程 → 刷新内容树」；`sync` 拉取远程并入本地。
- **目录化编辑**：不再面对一堆 `Template:首页%2F导航.mw` 扁平文件，而是 `content/Template/首页/导航.mw` 这样的目录树，同时无损回写回 git-mediawiki 要求的扁平结构。
- **安全的冲突语义**：content/ 与扁平仓库「两侧各自改同一页」时绝不静默覆盖，发布会中止并列出冲突文件。
- **多镜像支持**：同一 wiki 可配多个远程（快 / 慢端点），按序推送并自动对齐修订号，避免 non-fast-forward。
- **JSON 数据页支持**：可选在发布后把内容为合法 JSON 的 `.mw` 页面修正为 `json` 内容模型（`/Data` 这类数据页以数据视图展示）。
- **零第三方依赖**：纯 Node 内置模块，无需 npm install。

## 前置依赖

1. **Node.js ≥ 16**
2. **git-mediawiki**（[Git-Mediawiki](https://github.com/Git-Mediawiki/Git-Mediawiki)）：安装 `git-remote-mediawiki` / `git-mw` 两个助手与 `Git::Mediawiki` Perl 模块，并把助手放进 git-core（`PATH`）、模块目录放进 `PERL5LIB`，确保 `git clone mediawiki::…` 可用。

   **版本说明**：该项目**不发布 release tag**，只以 `master` 分支维护。

   **依赖要求**：
   - **Git**：任意较新版本（helper 以 git remote helper 方式被 git 调用，与 git 版本基本解耦）。
   - **Perl 模块（版本要求）**：
     - `MediaWiki::API` **≥ 0.39**（0.34 及更早不支持 mediafiles）
     - `DateTime::Format::ISO8601`
     - 其它实际用到的标准/常用模块：`HTML::TreeBuilder`、`LWP::UserAgent`、`URI::Escape`、`URI::URL`、`Git`（Perl 绑定）、`POSIX`、`Getopt::Long`
   - **系统包（Debian/Ubuntu 参考）**：`git`、`libmediawiki-api-perl`、`libdatetime-format-iso8601-perl`，以及 `libwww-perl`、`libhtml-tree-perl`、`liburi-perl`、`libgit-wrapper-perl` 等。

   > 若遇到「每次 pull 重复导入」或「作者名含 `< >` 导致 git ident 崩溃」，是上游已知问题，可参考仓库 `docs/` 中的补丁说明处理。
3. 一个已用 git-mediawiki **clone 好的扁平仓库**，且其 Git 配置中配置了 `remote.<名字>.mwlogin / mwpassword` 与命名空间（`git config remote.origin.namespaces` 等）。

## 快速开始

```bash
# 1) 复制本工具（或 clone 本仓库后），进入工具目录
cd git-mediawiki-tools

# 2) 生成你的配置
cp config.example.json config.json
#    编辑 config.json：wiki 仓库目录、远程名、命名空间等（见下节）

# 3) 配置登录凭据（交互输入，回显 *，写入扁平仓库 .git/config）
node bin/set-pass.js 你的用户名

# 4) 首次整理：把扁平仓库镜像成 content/ 内容树
node bin/content-sync.js mirror

# 5) 日常编辑发布
#    在 content/ 里新增/修改页面后：
node bin/publish.js "更新说明"

# 拉取线上最新并整理：
node bin/sync.js
```

若你的 wiki 启用了自定义命名空间（或 `Project` 等本地化名），务必同步改 `config.json` 的 `namespaces`。

## 配置（config.json）

由 `lib/config.js` 加载，优先级：环境变量 `GWMW_CONFIG` 指定的 JSON > 仓库根 `config.json` > 内置默认。`GWMW_REMOTE` 可临时覆盖 `remote` / `pushOrder`（逗号分隔）。

| 字段 | 默认 | 说明 |
|------|------|------|
| `wikiName` | `mywiki` | 仅用于日志文案 |
| `wikiBaseUrl` | — | 站点地址（用于推导 `apiUrl`） |
| `apiUrl` | — | MediaWiki API 地址；JSON 数据页修正用 |
| `remote` | `origin` | 主 mediawiki 远程名 |
| `pushOrder` | `["origin"]` | 推送顺序；同一 wiki 有镜像端点时可 `["accel","origin"]` |
| `wikiRepo` | `wiki.mywiki` | 扁平 git-mediawiki 仓库目录（相对本工具根或绝对） |
| `contentDir` | `content` | 内容树目录（相对本工具根或绝对） |
| `namespaces` | 标准集 | 纳入管理的命名空间（不含主命名空间与 File 图片） |
| `defaultUser` | — | `set-pass` 默认用户名 |
| `jsonContentModels` | `false` | 发布后把合法 JSON 的 `.mw` 页设为 json 内容模型 |
| `timeoutMs` | `180000` | git 操作的硬超时 |
| `preview` | — | 本地预览配置段（`mediawikiDir`/`port`/`dbFile`/`adminUser` 等），见「本地预览(可选)」 |

> 命名空间里 `_` 是 MediaWiki 内部写法（如 `User_talk`）；若你的 `Project` 命名空间有本地化名（例如 `久远澪Wiki`），请把该本地名也加入。

## 命令参考

| 命令 | 作用 |
|------|------|
| `node bin/publish.js "说明"` | 提交本地改动并推送（可再给远程名参数会忽略，始终按 `pushOrder` 推） |
| `node bin/sync.js [远程]` | 拉取远程（缺省主 remote）并变基、整理进 content/ |
| `node bin/set-pass.js [用户]` | 设置登录凭据（写入 `remote.<remote>.mwlogin/mwpassword`） |
| `node bin/content-sync.js status` | 查看两侧差异（`!` = 冲突） |
| `node bin/content-sync.js mirror` | 扁平仓库 → 内容树（首次初始化） |
| `node bin/content-sync.js flatten` | 内容树 → 扁平仓库（一般 publish 已自动做） |
| `node bin/content-sync.js check` | 往返一致性自检 |
| `node bin/content-sync.js dedupe-images` | 内容树图片与扁平仓库硬链接去重 |
| `node bin/preview.js start\|stop\|squash` | 本地预览（可选）：起停 php + 监听导入 / 退出精简历史 |

也可 `npm link` 后用全局命令 `mw-publish` / `mw-sync` / `mw-content-sync` / `mw-preview` 等。

## 内容树约定

- `content/pages/`：主命名空间页面（无前缀）。
- `content/<命名空间>/`：各命名空间目录；标题里的 `/` 用真实子目录表示。
- **`index.mw`**：既是页面、又有子页面的「父页面」正文放这里（例如 `Template:展示卡片` 的正文 → `Template/展示卡片/index.mw`，其 `/doc` 子页 → 同目录 `doc.mw`）。避免文件系统上同名文件与目录冲突。
- `content/images/`：二进制图片；与扁平仓库同名图片以硬链接共享同一份数据（磁盘只存一份）。
- 页面文件名里的 `_` 在 MediaWiki 等价于空格，请保持原样，不要手动改成空格再发布。

## 本地预览（可选）

可选的开发体验：在本地建立起一套轻量 MediaWiki，把扁平仓库的 `.mw` 导入其中，改完立刻刷新看渲染、不打扰线上——尤其适合调模板 / TemplateStyles / Lua。本仓库提供 Node 版预览模块 `bin/preview.js`（MediaWiki 本体仍需 PHP 运行，Node 负责启停/监听/导入/精简）：

```bash
# 需在 config.json 配置 preview.*（mediawikiDir / dbFile 等）
# 仓库根目录下可直接用 npm scripts：
npm run preview:start    # 等同 node bin/preview.js start
npm run preview:stop     # 等同 node bin/preview.js stop

# 或直接调用：
node bin/preview.js start    # 启动 php -S + 文件监听（前台；Ctrl+C 退出自动精简历史）
node bin/preview.js stop     # 停止并精简本地历史
node bin/preview.js squash   # 仅精简本地 DB 历史（保留每页最新）
node bin/preview.js import <file>...  # 一次性导入指定 .mw / 图片
```

实现要点（也便于自建）：
- **起站**：`php -S` + SQLite；把 `$wgParserCacheType` 设为 `CACHE_NONE`，保证每次请求都渲染最新。
- **导入**：用「`title<TAB>路径`」清单跑 `maintenance/importPagesManifest.php`（内容未变自动跳过、幂等），比逐页 edit 快。
- **监听**：`content/` ~1s 轮询 + mtime 快照（天然覆盖新建子目录），扁平仓库 fs.watch 变更即导入；保存 `content/` 的 `.mw` 会回写扁平仓库工作树（不自动 commit，冲突跳过）；图片只参与预览。
- **退出精简**：本地库只是可由 `content/` 重建的镜像——退出时把每页精简到只剩最新 revision 并 VACUUM（Node 内调 PHP 执行 SQLite 清理，保持零依赖）。
- **缓存刷新**：改 TemplateStyles / Common.css 后浏览器可能用旧样式（site.styles 的 load.php URL 无 version 参数、解析缓存需 purge）；验证时可绕过缓存取最新 CSS。

## 进阶

### 同一 wiki 多镜像（快 / 慢端点）

若你的 wiki 有加速镜像（同一后端、revision 一致），把它作为 `pushOrder` 的**首位**可显著提速并避免主站推送被非快进检查拒绝：

```json
{ "pushOrder": ["accel", "origin"] }
```

发布脚本会在首位推送成功后，把其记录的最新修订号同步到后续远程的 notes 并逐一对齐引用。

### JSON 数据页（如 命名空间:某页/Data）

把 `jsonContentModels` 设为 `true` 并提供 `apiUrl`（或 `wikiBaseUrl`）。推送后脚本会扫描仓库里内容为合法 JSON 的 `.mw` 文件，通过 API 把它们的内容模型修正为 `json`（幂等，已是 json 的跳过）。

## 常见问题

- **推送被拒 non-fast-forward**：说明远程有你本地没有的修订。先 `node bin/sync.js` 同步；若本地 notes 修订号落后于远程（例如站端直接编辑产生了新修订而 recentchanges 滞后），需要把本地 notes 播种到远程实际修订号后重推。
- **受保护页面无法推送**：如 `MediaWiki:Common.css` 等受保护页面机器人无权限，推送会整体失败。把该页面从推送历史中剔除（`git rebase -i` 合并提交），样式改走 TemplateStyles 子页。
- **内容树冲突**：`content/` 与扁平仓库两侧各自改了同一页 → 发布中止并列出。把该页在两处取一致后重跑即可。
- **新增命名空间后旧页被跳过**：命名空间变更后需要完整重导（删除 notes 重新 clone），否则旧页面会被全局修订号跳过。

## 许可

[MIT](LICENSE)
