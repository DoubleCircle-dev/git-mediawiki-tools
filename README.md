# git-mediawiki-tools

本工具用于通过 Git 管理 MediaWiki 站点。工具基于 [Git-Mediawiki](https://github.com/Git-Mediawiki/Git-Mediawiki) 远程助手，实现 Wiki 内容的同步与发布，并通过 **content/ 内容树**将扁平仓库整理为按命名空间和子页面组织的目录结构，以便浏览、编辑和审阅变更。

## 特性

- **同步与发布**：`publish` 自动执行“内容树回写 → Git 提交 → 推送远程 → 刷新内容树”流程；`sync` 负责拉取远程变更并整合到本地。
- **目录化编辑**：将 `Template:首页%2F导航.mw` 等扁平文件映射为 `content/Template/首页/导航.mw` 等目录结构，并可无损回写为 Git-Mediawiki 所需的扁平结构。
- **Git 原生冲突处理**：当 content/ 与扁平仓库分别修改同一页面时，工具将冲突写入 Git 索引并标记为 `UU`，禁止静默覆盖；用户可使用 VS Code 内置合并编辑器处理冲突。
- **多远程支持**：同一 Wiki 可配置多个远程端点，并按照指定顺序推送和对齐修订号，以降低 `non-fast-forward` 错误风险。
- **JSON 数据页支持**：可在发布后将内容为合法 JSON 的 `.mw` 页面修正为 `json` 内容模型，使 `/Data` 等数据页面按数据视图展示。
- **零第三方依赖**：仅使用 Node.js 内置模块，无需执行 `npm install`。

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

如果 Wiki 启用了自定义命名空间，或使用了 `Project` 等命名空间的本地化名称，应同步更新 `config.json` 中的 `namespaces` 配置。

## 配置（config.json）

配置由 `lib/config.js` 加载，优先级依次为：环境变量 `GWMW_CONFIG` 指定的 JSON 文件、仓库根目录下的 `config.json`、内置默认值。`GWMW_REMOTE` 可临时覆盖 `remote` 和 `pushOrder`；`MW_PUSH_ORDER` 可临时覆盖推送顺序，后者仅用于发布脚本。

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
| `node bin/publish.js "说明"` | 提交本地变更并推送。命令行中附加的远程名参数将被忽略，工具始终按照 `pushOrder` 推送；可使用 `MW_PUSH_ORDER=origin` 临时覆盖推送顺序；`--yes` 用于跳过待删除页面确认。 |
| `node bin/sync.js [远程]` | 拉取远程变更、执行变基并整理到 content/；未指定远程时使用主远程。 |
| `node bin/set-pass.js [用户]` | 配置登录凭据，写入 `remote.<remote>.mwlogin` 和 `mwpassword`。 |
| `node bin/content-sync.js status` | 查看扁平仓库与内容树之间的差异；`!` 表示存在冲突。 |
| `node bin/content-sync.js mirror` | 将扁平仓库同步到内容树，用于首次初始化或以扁平仓库内容为准刷新；检测到 content/ 本地变更时将其写入 Git 冲突，并要求使用 `--force`。 |
| `node bin/content-sync.js flatten` | 将内容树回写到扁平仓库；检测到扁平仓库存在未提交变更时将其写入 Git 冲突，并要求使用 `--force`。 |
| `node bin/content-sync.js check` | 往返一致性自检 |
| `node bin/content-sync.js conflicts` | 列出冲突并将其写入 Git（状态为 `UU`），供 VS Code 的“合并更改”区域处理。 |
| `node bin/content-sync.js resolve` | 逐项处理冲突；两侧内容一致后自动进入下一项，也可输入 `f`、`c`、`s` 或 `q` 选择相应操作。 |
| `node bin/content-sync.js apply` | 仅执行冲突收尾：将已解决的冲突暂存并同步回 content/，不执行同步；存在未解决冲突时返回退出码 1。 |
| `node bin/content-sync.js git-merge` | 将冲突写入 Git 索引并标记为 `UU`，供 VS Code 源代码管理面板和合并编辑器处理；`--abort` 用于撤销本次操作。检测到冲突时通常已自动执行该步骤。 |
| `npm run open-conflicts` | 逐项打开冲突文件；默认直接在 VS Code 中打开，`--mode diff` 用于打开两窗格差异视图。每处理完一项后按回车继续。 |
| `node bin/content-sync.js dedupe-images` | 内容树图片与扁平仓库硬链接去重 |
| `node bin/preview.js start\|stop\|squash` | 本地预览（可选）：起停 php + 监听导入 / 退出精简历史 |

执行 `npm link` 后，也可使用全局命令 `mw-publish`、`mw-sync`、`mw-content-sync` 和 `mw-preview`。

## 内容树约定

两个方向均为“**以指定一侧为准**”的单向复制，不执行自动合并：

- `mirror`（扁平仓库 → 内容树）：以扁平仓库（线上来源）为准刷新内容树；
- `flatten`（内容树 → 扁平仓库）：以内容树为准回写扁平仓库，**不删除**页面。

因此，两者均可能覆盖对侧同名文件的变更，包括未提交变更。命令行工具会在覆盖前列出受影响文件，
并要求使用 `--force`；未指定该选项时，操作将中止。在同一状态下连续执行两个方向的同步，
无法替代明确的冲突处理流程。

要合并两侧变更，**无需安装额外插件**。工具检测到冲突后，会将冲突直接写入 Git：扁平仓库索引
标记为 `UU`，工作树写入 `<<<<<<<` 等冲突标记。用户可通过 VS Code 内置的 Git 面板和合并编辑器
完成处理。

### 冲突流程（默认）

以下命令检测到冲突时，均会执行相同的 Git 冲突写入流程：`status`、`conflicts`、`diff`、`resolve`、
`mirror`（拦截时）、`flatten`（拦截时）和 `publish`（中止时）：

1. 在扁平仓库索引中写入三个 stage：`1` 为 `HEAD`（共同祖先），`2` 为扁平工作树（**线上版本**，
   合并编辑器中的 **Current**），`3` 为 `content/`（**本地版本**，**Incoming**）。工作树文件将写入
   `<<<<<<<` 等冲突标记，`git status` 将显示 `UU`，VS Code 源代码管理面板会将其列入**“合并更改”**。

二进制图片，以及仅有一侧存在文件的删除或新增类冲突无法执行三方合并。对于此类冲突，工具将
跳过三方合并并提示用户使用 `resolve` 选择一侧。

然后：

1. 在 VS Code 的**源代码管理**面板中打开“**合并更改**”，选择文件的“**在合并编辑器中解决**”。
   也可以设置 `"git.mergeEditor": true`，使双击文件时直接打开三方合并编辑器。
2. 在合并编辑器中确认 **Current** 为扁平仓库的线上版本、**Incoming** 为 content/ 的本地版本，
   选择 Accept Current 或 Accept Incoming，完成合并。
3. 再次执行 `flatten`、`publish`、`sync` 或 `apply`。工具会将已解决的文件执行 `git add`，使其从
   VS Code 的**“合并更改”**移动到**“暂存更改”**，并同步回 `content/`。

```bash
node bin/content-sync.js git-merge         # 手动将当前冲突写入 Git
node bin/content-sync.js git-merge --abort # 撤销本次合并，恢复扁平侧工作树并清理索引
node bin/content-sync.js apply             # 仅执行冲突收尾，不执行同步
```

> - 未完成合并前重新执行命令，只会提示仍存在的冲突；`sync` 将直接中止，不会带着 `<<<<<<<` 标记执行
>   fetch 或 rebase。
> - 完成合并后无需手动执行 stage。下次执行同步或发布命令时，工具会自动执行 `git add`；即使编辑器
>   仅保存文件而未暂存，工具也会自动补充暂存操作。
> - 未解决的路径不会被提交或推送。`publish` 将中止，Git 也会拒绝提交包含未解决路径的提交。
> - `--force` 表示以指定一侧为准：`mirror --force` 采用扁平仓库（线上）版本，`flatten --force`
>   采用 `content/` 版本，并清理相应的 Git 冲突条目。

### 特殊情形：非文本页（二进制 / 删除类）

三方合并仅适用于“两侧均存在文件的文本页面”。二进制图片，以及仅有一侧存在文件的删除或新增类冲突
不适用三方合并。工具会在输出中列出此类冲突，用户可使用交互式命令选择一侧：

```bash
node bin/content-sync.js resolve     # 逐项输入 f（扁平→内容）/ c（内容→扁平）/ s（跳过）/ q（退出）
```

也可以使用任意文本编辑器修改扁平仓库中带有 `<<<<<<<` 标记的工作树文件：保留最终正文并删除
冲突标记。或者将两侧文件修改为一致后重新执行同步命令。工具将执行冲突收尾，包括暂存和同步回 content/。

想逐个无障碍处理（打开一个、处理完回车开下一个）：

```bash
npm run open-conflicts                  # 默认：在 VS Code 里打开冲突文件本身（可用合并编辑器）
npm run open-conflicts -- --mode diff    # 改为两窗格对照：code --diff 扁平 内容
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

本工具提供可选的本地预览环境。该环境建立一套轻量 MediaWiki 实例，将扁平仓库中的 `.mw` 文件导入其中，
用于本地检查渲染结果，不影响线上站点，适用于模板、TemplateStyles 和 Lua 等内容的开发调试。本仓库提供
Node.js 版预览模块 `bin/preview.js`；MediaWiki 本体仍由 PHP 运行，Node.js 负责服务启停、文件监听、内容导入和历史精简。

> **重要警告：本地预览实例仅用于渲染验证，不得将本地 MediaWiki 地址配置为 Git-Mediawiki 的远程端点。**
> 本工具不支持在本地 MediaWiki 与线上 Wiki 之间进行同步，也不支持将本地预览站点作为 `remote`、
> `pushOrder` 或 `remotes` 中的远程目标。请始终使用线上 Wiki 对应的 Git-Mediawiki 远程；本地预览应仅接收
> 本地扁平仓库或内容树的导入。这样可以避免将本地测试数据、历史记录或删除操作误推送至线上，或将线上内容
> 错误导入本地预览的同步链路。

### 安装本地 MediaWiki

本地预览需要预先安装一套 MediaWiki。依赖包括：**PHP ≥ 7.4**（建议使用 8.x，并启用 `pdo_sqlite`、`curl`、
`mbstring`、`xml` 等扩展）、**Composer** 和 **Git**。

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
6. **克隆本地仓库（可选，用于本地 Wiki 编辑测试）**：`git clone "mediawiki::http://127.0.0.1:8080/" wiki.mywiki`，并在 `.git/config` 中配置凭据和命名空间。

```bash
# 需在 config.json 配置 preview.*（mediawikiDir / dbFile 等）
# 在仓库根目录执行以下 npm scripts：
npm run preview:start    # 等同 node bin/preview.js start
npm run preview:stop     # 等同 node bin/preview.js stop

# 也可以直接调用以下命令：
node bin/preview.js start    # 启动 php -S + 文件监听（前台；Ctrl+C 退出自动精简历史）
node bin/preview.js stop     # 停止并精简本地历史
node bin/preview.js squash   # 仅精简本地 DB 历史（保留每页最新）
node bin/preview.js import <file>...  # 一次性导入指定 .mw / 图片
```

实现要点如下：
- **服务启动**：使用 `php -S` 和 SQLite；将 `$wgParserCacheType` 设置为 `CACHE_NONE`，确保每次请求均使用最新内容进行渲染。
- **内容导入**：通过包含「`title<TAB>路径`」的清单执行 `maintenance/importPagesManifest.php`。内容未发生变化时自动跳过，操作具有幂等性。
- **文件监听**：对 `content/` 进行约 1 秒一次的轮询并记录 mtime 快照；扁平仓库发生 `fs.watch` 变更时立即导入。保存 `content/` 中的 `.mw` 文件后会回写扁平仓库工作树，但不会自动提交；发生冲突时跳过回写。图片仅参与预览。
- **退出时精简历史**：本地数据库是可由 `content/` 重建的镜像。退出时将每页历史精简为最新 revision 并执行 VACUUM；SQLite 清理由 Node.js 调用 PHP 完成，不引入额外依赖。
- **缓存刷新**：修改 TemplateStyles 或 Common.css 后，浏览器可能继续使用旧样式。由于 site.styles 的 load.php URL 不包含版本参数，解析缓存还需要执行 purge；验证时可绕过缓存读取最新 CSS。

## 进阶

### 同一 Wiki 的多个镜像（快速端点 / 常规端点）


### 远程角色：主站 / 加速链接 / 镜像站

可使用 `remotes` 为各远程指定角色，以确定推送顺序及远程之间的替代关系。未配置角色时，
`pushOrder` 中的每个远程均按 `primary` 处理，以保持原有行为：

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

每个远程在推送前均会独立执行一次同步（`fetch`，并采用线上新修订或执行变基）。如果线上 tip 领先本地，
例如推送窗口内发生了页面编辑，工具会直接采用 fast-forward，不会丢弃新修订。
推送失败时，脚本读 helper 打印的 `Last remote revision found is N`，再查该站点 API：
若最新修订 > N 就提示「**该仓库有人上传 / 站端刚编辑**」并建议先 `npm run sync`；
失败远程的跟踪引用**不会**被对齐，以免被误判成已同步、下次不再重试。

**加速链接保护机制**：

1. **推送前可达性预检**：对于 HTTP(S) 远程，先请求一次 `api.php`（超时 15 秒）。如果地址无法解析
   或站点不可访问，工具会在约 1 秒内报告「❌ accel 预检失败：无法访问 …（ENOTFOUND）」；随后继续处理其他远程，
   不会使远程助手持续等待至超时。
2. **同后端校验**：`accel` 推送成功并准备跳过其 `binds` 源站之前，比对两个站点最近 5 条
   `recentchanges`（revid、页面和用户）。**仅当结果完全一致时才跳过源站**；如果存在差异，工具会列出差异并
   **继续单独推送源站**；如果无法查询（例如站点 API 不可用），也不会跳过源站。
   确实同后端、想省掉这次校验时，给该 accel 远程加 `"verifyParity": false`。

如需临时仅推送指定远程（例如加速链接不可用或需要直接使用主站）：
`MW_PUSH_ORDER=origin node bin/publish.js "说明"`（此时配置里的其它远程不会补进来）。

### JSON 数据页（如 命名空间:某页/Data）

将 `jsonContentModels` 设置为 `true`，并提供 `apiUrl`（或 `wikiBaseUrl`）。推送后，脚本会扫描仓库中内容为合法 JSON 的 `.mw` 文件，通过 API 将其内容模型修正为 `json`；已为 `json` 模型的页面将自动跳过。

## 测试

测试不依赖第三方库，使用 Node.js 内置的 `node:test`，并在 `os.tmpdir()` 下创建临时 Git 仓库沙盒。
测试过程**不会修改真实仓库或线上站点**：

```bash
npm test                        # 全部用例
KEEP_TEST_SANDBOX=1 npm test    # 失败时保留沙盒现场（打印路径）
```

`test/content-sync.test.js` 覆盖 content/ 内容树与扁平仓库之间的**冲突处理流程**，包括：

- 判定矩阵：两侧一致 / 仅内容树改（待回写）/ 仅扁平改（扁平新改动）/ 两侧各自改（**冲突**）/ 内容树删页（待删除）；
- 冲突写进 git：index 三个 stage、`git status` 为 `UU`、工作树带 `<<<<<<<` 标记；
- 冲突时 `applyPublish` 中止（content/ 不被改动），已解决的冲突重跑命令后进**暂存区**并同步回 content/；
- `resolve` 交互流程：在命令行输入 `f`（采用扁平→内容）或 `c`（采用内容→扁平）后完成冲突处理，并继续发布；
- 布局冲突：`X.mw` 与 `X/index.mw` 并存 → 检出 `dup` 并拒绝发布（附处置建议）；
- 映射与去重：`mirrorRel` ↔ `flatName` 往返一致、`flatten` 幂等、`content/images` 与扁平仓库图片共享 inode；
- CLI：`status` / `conflicts` / `check` 的输出与退出码。

> 已知的保守判定：`resolve` 采用某一侧后，如果**扁平工作树仍存在未提交变更**，随后再次修改 `content/` 可能被判定为“两侧分别修改同一页面”；建议在 `resolve` 完成后先执行一次发布，使扁平侧状态形成新的基线，再继续编辑。

## 常见问题

- **推送被拒 `non-fast-forward`**：说明远程包含本地尚未获取的修订。应先执行 `node bin/sync.js`；如果本地 notes 中的修订号落后于远程实际修订号（例如站点直接编辑造成 recentchanges 暂时滞后），应将本地 notes 更新为远程实际修订号后再次推送。
- **受保护页面无法推送**：例如 `MediaWiki:Common.css` 等受保护页面可能不允许机器人账户修改，导致整体推送失败。应将该页面从推送历史中移除（可使用 `git rebase -i` 合并提交），并将样式修改迁移至 TemplateStyles 子页面。
- **内容树冲突**：当 `content/` 与扁平仓库分别修改同一页面时，发布将中止并列出冲突。应在 VS Code 合并编辑器中处理该 Git 冲突，完成后重新执行相应命令。
- **页面删除**：删除 `content/` 中的页面后，`publish` 将其列为待删除项目并请求确认（可使用 `--yes` 或 `MW_PUBLISH_YES=1` 跳过确认；**非交互终端必须显式确认**）。Git-Mediawiki **无法直接删除线上页面**，只能改写页面正文：wikitext 页面写入 `[[Category:Deleted]]`；Scribunto、sanitized-css、CSS、JS 和 JSON 页面因内容校验无法接受该文本，将自动改写为**对应格式的注释占位内容**（Lua `-- …`、CSS `/* … */`、JS `// …`、JSON `{"_comment": …}`）。发布结束时将提示用户通过线上 `Special:Delete` 或 API `action=delete` 执行实际删除。
- **新增命名空间后旧页面被跳过**：修改命名空间配置后，需要执行完整重新导入（删除 notes 并重新 clone），否则旧页面可能因全局修订号判断而被跳过。

## 许可

[MIT](LICENSE)
