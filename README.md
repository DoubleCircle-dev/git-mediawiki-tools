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

由 `lib/config.js` 加载，优先级：环境变量 `GWMW_CONFIG` 指定的 JSON > 仓库根 `config.json` > 内置默认。`GWMW_REMOTE` 可临时覆盖 `remote` / `pushOrder`（逗号分隔）；`MW_PUSH_ORDER` 也可临时覆盖推送顺序（效果相同，发布脚本专用）。

| 字段 | 默认 | 说明 |
|------|------|------|
| `wikiName` | `mywiki` | 仅用于日志文案 |
| `wikiBaseUrl` | — | 站点地址（用于推导 `apiUrl`） |
| `apiUrl` | — | MediaWiki API 地址；JSON 数据页修正用 |
| `remote` | `origin` | 主 mediawiki 远程名 |
| `pushOrder` | `["origin"]` | 推送顺序；同一 wiki 有镜像端点时可 `["accel","origin"]` |
| `remotes` | `{}` | 远程角色：`{"accel":{"role":"accel","binds":"origin"},"mirror":{"role":"mirror"}}`（见「远程角色」；可选 `"verifyParity": false` 跳过同后端校验） |
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
| `node bin/publish.js "说明"` | 提交本地改动并推送（可再给远程名参数会忽略，始终按 `pushOrder` 推；`MW_PUSH_ORDER=origin` 可临时覆盖；`--yes` 跳过待删页确认） |
| `node bin/sync.js [远程]` | 拉取远程（缺省主 remote）并变基、整理进 content/ |
| `node bin/set-pass.js [用户]` | 设置登录凭据（写入 `remote.<remote>.mwlogin/mwpassword`） |
| `node bin/content-sync.js status` | 查看两侧差异（`!` = 冲突） |
| `node bin/content-sync.js mirror` | 扁平仓库 → 内容树（首次初始化）；会回退 content/ 侧本地改动时**先自动生成冲突 diff** 并要求 `--force` |
| `node bin/content-sync.js flatten` | 内容树 → 扁平仓库（一般 publish 已自动做）；会覆盖扁平仓库未提交改动时**先自动生成冲突 diff** 并要求 `--force` |
| `node bin/content-sync.js check` | 往返一致性自检 |
| `node bin/content-sync.js conflicts` | 列出冲突并生成 `<内容树同级>/.content-sync/conflicts/*.diff` + `index.md` |
| `node bin/content-sync.js resolve` | 逐个解决冲突：停在命令行，**两侧改到一致会自动进入下一项**（也可 f/c/s/q） |
| `node bin/content-sync.js apply` | 只做复检写回（git 冲突 / 改过的 diff 都认），不跑同步（有遗留冲突时退出码 1） |
| `node bin/content-sync.js git-merge` | 把冲突写成**真实 git 冲突**（`UU`）供 VS Code 源代码管理面板 → 合并编辑器处理（检测到冲突时已自动做过）；`--abort` 撤销 |
| `npm run open-conflicts` | 逐个打开冲突（默认 `code --merge`，`--mode diff` 改差异编辑器）；回车开下一个 |
| `node bin/content-sync.js dedupe-images` | 内容树图片与扁平仓库硬链接去重 |
| `node bin/preview.js start\|stop\|squash` | 本地预览（可选）：起停 php + 监听导入 / 退出精简历史 |

也可 `npm link` 后用全局命令 `mw-publish` / `mw-sync` / `mw-content-sync` / `mw-preview` 等。

## 内容树约定

两个方向都是「**整体以某一侧为准**」的单向复制，不会自动合并：

- `mirror`（扁平仓库 → 内容树）：以扁平仓库（线上）为准刷新内容树；
- `flatten`（内容树 → 扁平仓库）：以内容树为准回写扁平仓库（**不删除**页面）。

因此两者都可能覆盖对侧同名文件的改动（含未提交改动）。CLI 会在覆盖前列出清单并要求
`--force`（不加则中止），同一份状态里连着跑两个方向也看不出干净结果。

要合并两侧改动，**不需要装任何插件**：工具检测到冲突时会直接把冲突**写进 git**
（扁平仓库 index 标为 `UU`，工作树写入 `<<<<<<<` 标记），你在 VS Code 里用自带的 Git 面板
+ 合并编辑器解决即可。

### 冲突流程（默认）

任何命令检测到冲突（`status` / `conflicts` / `diff` / `resolve` / `mirror` 拦截时 / `flatten` 拦截时 /
`publish` 中止时）都会：

1. 在扁平仓库 index 里写入三个 stage —— `1` = `HEAD`（共同祖先）、`2` = 扁平工作树（**线上**，
   合并编辑器里的 **Current**）、`3` = `content/`（**本地**，**Incoming**），工作树文件写成带
   `<<<<<<<` 标记的版本；于是 `git status` 显示 `UU`，VS Code 源代码管理面板把它列进**「合并更改」**；
2. 顺便在 `<内容树同级>/.content-sync/conflicts/` 留一份**文本兜底**（`<页>.diff` + `index.md`），
   供无 git / 非文本页使用。

然后：

1. VS Code **源代码管理** → 「**合并更改**」→ 点文件上的「**在合并编辑器中解决**」
   （或设 `"git.mergeEditor": true` 后双击文件直接进 3 方合并编辑器）
2. 合并器里 **Current = 扁平仓库 / 线上**，**Incoming = content/ 本地** → 选 Accept Current / Incoming
   → 点**「完成合并」**
3. 回来**重跑那条命令**（`flatten` / `publish` / `sync`，或只复检的 `apply`）：工具会把结果
   `git add` 进暂存区 —— VS Code 里就是 **「合并更改」→「暂存更改」**（同时同步回 `content/`），
   之后你可以在 Git 面板直接提交/推送，或让它继续跑同步

```bash
node bin/content-sync.js git-merge        # 也可以手动执行：把当前冲突写进 git
node bin/content-sync.js git-merge --abort # 放弃这次合并：还原扁平侧工作树 + 清 index
node bin/content-sync.js apply            # 只复检写回，不跑同步（有遗留冲突时退出码 1）
```

> - 只关标签页、不点「完成合并」＝仍未解决；重跑命令只会提示还剩哪些（`sync` 会直接中止，
>   不会带着 `<<<<<<<` 去 fetch/rebase）。
> - 点击「完成合并」后**不必手动 stage**：下次跑任何同步/发布命令时，工具会做 `git add`
>   （若编辑器只保存没 stage，也一样会补上）。
> - **没有解决之前不会提交**：`publish` 会中止（`git` 本身也拒绝提交 unmerged 的路径），
>   不会把 `<<<<<<<` 标记推到线上。
> - `--force` 是「以某一侧为准」的语义：`mirror --force` 按扁平/线上采用、`flatten --force` 按
>   `content/` 采用，并顺手清掉这些 git 冲突条目。

### 兜底：非文本页 / 无 git 环境

二进制图片、以及「只有一侧有文件」的删除/新增类冲突无法三方合并，会被自动跳过（提示里会列出来）：

- 用 `node bin/content-sync.js resolve` 逐项输 `f`（扁平→内容）/ `c`（内容→扁平）；
- 或用**任何文本编辑器**打开 `.content-sync/conflicts/<页>.diff`，整份替换成该页**最终正文**
  （别留 `-`、`+`、`@@` 这些 diff 符号），保存后重跑命令 —— 工具复检（不会产生新冲突才写）
  后写回两侧，并把 `.diff` 归档为 `<页>.diff.done`。

想在 VS Code 里逐个无障碍处理（弹一个、解决一个回车下一个）：

```bash
npm run open-conflicts                  # 逐个打开三方合并编辑器（code --merge，结果写进 .diff）
npm run open-conflicts -- --mode diff    # 改为逐个打开差异编辑器（code --diff）
```

VS Code 内部（不敲命令）：`Ctrl+Shift+P` → **任务: 运行任务**（Tasks: Run Task），可选
「冲突：写进 git」「冲突：复检并写回两侧」「冲突：逐个打开…」「同步：flatten」「状态：查看两侧差异」；
任务定义在 `.vscode/tasks.json`，也可从终端菜单 **终端 → 运行任务** 进入。

- `content/pages/`：主命名空间页面（无前缀）。
- `content/<命名空间>/`：各命名空间目录；标题里的 `/` 用真实子目录表示。
- **`index.mw`**：既是页面、又有子页面的「父页面」正文放这里（例如 `Template:展示卡片` 的正文 → `Template/展示卡片/index.mw`，其 `/doc` 子页 → 同目录 `doc.mw`）。避免文件系统上同名文件与目录冲突。
- `content/images/`：二进制图片；与扁平仓库同名图片以硬链接共享同一份数据（磁盘只存一份）。
- 页面文件名里的 `_` 在 MediaWiki 等价于空格，请保持原样，不要手动改成空格再发布。

## 本地预览（可选）

可选的开发体验：在本地建立起一套轻量 MediaWiki，把扁平仓库的 `.mw` 导入其中，改完立刻刷新看渲染、不打扰线上——尤其适合调模板 / TemplateStyles / Lua。本仓库提供 Node 版预览模块 `bin/preview.js`（MediaWiki 本体仍需 PHP 运行，Node 负责启停/监听/导入/精简）：

### 安装本地 MediaWiki

本地预览需要先装一套 MediaWiki。前置：**PHP ≥ 7.4**（建议 8.x，需 `pdo_sqlite`、`curl`、`mbstring`、`xml` 等）、**Composer**、**Git**。

1. **获取 MediaWiki**：官方 [releases.wikimedia.org](https://releases.wikimedia.org/mediawiki/)，或 GitHub 镜像 [wikimedia/mediawiki](https://github.com/wikimedia/mediawiki) 的 codeload tarball（如 `…/tar.gz/refs/heads/REL1_46`）解压到目录。
2. **安装 PHP 依赖**（tarball 不含 vendor/）：
   ```bash
   composer install --no-dev
   # root 运行时需：COMPOSER_ALLOW_SUPERUSER=1
   # composer 因安全通告阻断：composer config policy.advisories.block false
   ```
3. **生成配置与数据库**（SQLite 库放 `data/`）：
   ```bash
   mkdir data
   php maintenance/install.php --dbtype=sqlite --dbpath=data \
     --pass='管理员密码' --scriptpath='' Admin
   ```
4. **加配置并起预览服务**（`LocalSettings.php` 加 `$wgParserCacheType = CACHE_NONE;` 保证实时渲染）：
   ```bash
   php -S 127.0.0.1:8080
   ```
5. **按需加扩展 / 皮肤**：目录放进 `extensions/` / `skins/`，在 `LocalSettings.php` 用 `wfLoadExtension('…')` / `wfLoadSkin('…')` 显式加载。
6. **clone 本地（可选，如果仅本地测试wiki编辑）**：`git clone "mediawiki::http://127.0.0.1:8080/" wiki.mywiki`，并在 `.git/config` 配好凭据与命名空间。

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

### 远程角色：主站 / 加速链接 / 镜像站

用 `remotes` 给每个远程标角色，决定推送顺序与「谁能代替谁」（未配置时 `pushOrder` 里每个远程都按 `primary`，即旧行为）：

```json
{
  "pushOrder": ["accel", "origin", "mirror"],
  "remotes": {
    "accel":  { "role": "accel", "binds": "origin" },
    "origin": { "role": "primary" },
    "mirror": { "role": "mirror" }
  }
}
```

| 角色 | 含义 | 推送行为 |
|------|------|----------|
| `primary` 主站 | 主要推送的站点 | 必须推；失败时发布报错（其余远程继续尝试） |
| `accel` 加速链接 | **绑定某个源站（`binds`）的同一 wiki 端点**（同一后端、修订号一致） | 先推它；成功后**跳过其绑定源站的推送**（内容已经上线），只把修订号同步给源站 notes + 对齐引用；它失败则自动回退、继续推源站 |
| `mirror` 镜像站 | **独立站点**（自己的修订号体系） | 各自单独推；与主站互不复制修订号；推送后不会立即同步主站，需等待镜像自身的同步 |

每个远程在推送前都会**各自 sync 一次**（`fetch` + 采用线上新修订/变基）：若线上 tip 领先本地
（例如推送窗口内有人编辑），直接 fast-forward 采用，不会再把新修订丢掉。
推送失败时，脚本读 helper 打印的 `Last remote revision found is N`，再查该站点 API：
若最新修订 > N 就提示「**该仓库有人上传 / 站端刚编辑**」并建议先 `npm run sync`；
失败远程的跟踪引用**不会**被对齐，以免被误判成已同步、下次不再重试。

**两道保护（加速链接相关）**：

1. **推送前可达性预检**：对 http(s) 远程先 GET 一次 `api.php`（15s 超时）。地址解析不了 /
   站点不可达会在 1 秒内报「❌ accel 预检失败：无法访问 …（ENOTFOUND）」，
   而不是让 helper 空等超时；随后继续其它远程。
2. **同后端校验**：`accel` 推送成功、准备跳过其 `binds` 源站之前，比对两站点最近 5 条
   `recentchanges`（revid + 页面 + 用户）。**只有完全一致才跳过源站**；不一致会列出差异并
   **照常单独推源站**；查不到（站点 API 不可用）也一律保守不跳过。
   确实同后端、想省掉这次校验时，给该 accel 远程加 `"verifyParity": false`。

临时只推指定远程（例如加速链接下线了、只想走主站）：
`MW_PUSH_ORDER=origin node bin/publish.js "说明"`（此时配置里的其它远程不会补进来）。

### JSON 数据页（如 命名空间:某页/Data）

把 `jsonContentModels` 设为 `true` 并提供 `apiUrl`（或 `wikiBaseUrl`）。推送后脚本会扫描仓库里内容为合法 JSON 的 `.mw` 文件，通过 API 把它们的内容模型修正为 `json`（幂等，已是 json 的跳过）。

## 测试

零依赖（Node 内置 `node:test`），全程在 `os.tmpdir()` 的临时 git 仓库沙盒里跑，**不碰真实仓库与线上**：

```bash
npm test                        # 全部用例
KEEP_TEST_SANDBOX=1 npm test    # 失败时保留沙盒现场（打印路径）
```

`test/content-sync.test.js` 覆盖 content/ 内容树 ↔ 扁平仓库的**冲突处理流程**：

- 判定矩阵：两侧一致 / 仅内容树改（待回写）/ 仅扁平改（扁平新改动）/ 两侧各自改（**冲突**）/ 内容树删页（待删除）；
- 冲突产物：`.content-sync/conflicts/<页>.diff`（a=扁平仓库、b=content/）+ `index.md`；
- 冲突时 `applyPublish` 中止，且**两侧文件都不被改动**；
- `resolve` 交互流程：命令行喂 `f`（采用扁平→内容）/ `c`（采用内容→扁平）后冲突消失、可继续发布；
- 布局冲突：`X.mw` 与 `X/index.mw` 并存 → 检出 `dup` 并拒绝发布（附处置建议）；
- 映射与去重：`mirrorRel` ↔ `flatName` 往返一致、`flatten` 幂等、`content/images` 与扁平仓库图片共享 inode；
- CLI：`status` / `conflicts` / `check` 的输出与退出码。

> 已知保守判定：`resolve` 采用某一侧后，若**扁平工作树仍是未提交改动**就直接再改 `content/`，会被当成「两侧各自改动」判冲突；正常流程是 `resolve` 后先发布一次（把扁平侧状态提交成基线）再继续编辑。

## 常见问题

- **推送被拒 non-fast-forward**：说明远程有你本地没有的修订。先 `node bin/sync.js` 同步；若本地 notes 修订号落后于远程（例如站端直接编辑产生了新修订而 recentchanges 滞后），需要把本地 notes 播种到远程实际修订号后重推。
- **受保护页面无法推送**：如 `MediaWiki:Common.css` 等受保护页面机器人无权限，推送会整体失败。把该页面从推送历史中剔除（`git rebase -i` 合并提交），样式改走 TemplateStyles 子页。
- **内容树冲突**：`content/` 与扁平仓库两侧各自改了同一页 → 发布中止并列出。把该页在两处取一致后重跑即可。
- **删除页面**：`content/` 中删掉的页面会被当成待删除，publish 先列出清单并等确认（`--yes` / `MW_PUBLISH_YES=1` 跳过；**非交互终端必须显式确认**）。注意 git-mediawiki **无法真正删网页**，只能改写正文：wikitext 页写成 `[[Category:Deleted]]`；Scribunto / sanitized-css / CSS / JS / JSON 页因内容校验无法接受该文本，会自动改写为**同格式注释占位**（Lua `-- …`、CSS `/* … */`、JS `// …`、JSON `{"_comment": …}`）。发布末尾会提醒这些页面仍需在线上用 `Special:Delete` 或 API `action=delete` 真正删除。
- **新增命名空间后旧页被跳过**：命名空间变更后需要完整重导（删除 notes 重新 clone），否则旧页面会被全局修订号跳过。

## 许可

[MIT](LICENSE)
