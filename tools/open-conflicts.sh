#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# 逐个打开冲突：一次一个，处理完回终端按回车打开下一个。
#
#   默认（--mode merge）在 VS Code 里打开冲突文件本身：
#       code <扁平文件>   → 源码管理可点「在合并编辑器中解决」，或用编辑器内联 Accept
#   --mode diff  两窗格对照：
#       code --diff <扁平> <内容>
#
# 冲突由工具写进 git（index 三个 stage + <<<<<<< 标记）；解决后重跑同步命令会自动
# 收尾（暂存：合并更改 → 暂存更改，并同步回 content/）。放弃：content-sync.js git-merge --abort
#
# 用法：
#   bash tools/open-conflicts.sh [--mode merge|diff] [--flat DIR] [--content DIR]
#   npm run open-conflicts [-- --mode diff]
# 沙盒：GWMW_CONFIG=/root/wiki/tmp/cs-playground/config.json bash tools/open-conflicts.sh
# ---------------------------------------------------------------------------
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"            # git-mediawiki-tools/
CS="$ROOT/bin/content-sync.js"

MODE=merge
FLAT=""
CONTENT=""

usage() {
  sed -n '2,16p' "$HERE/open-conflicts.sh" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --mode) MODE="${2:-}"; shift 2 ;;
    --merge) MODE=merge; shift ;;
    --diff) MODE=diff; shift ;;
    --flat) FLAT="${2:-}"; shift 2 ;;
    --content) CONTENT="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知参数：$1（-h 看用法）" >&2; exit 2 ;;
  esac
done
case "$MODE" in
  merge|diff) ;;
  *) echo "--mode 只能是 merge 或 diff" >&2; exit 2 ;;
esac

command -v code >/dev/null 2>&1 || {
  echo "✗ 找不到 code（VS Code 命令行）。" >&2
  echo "  没有 VS Code 也行：冲突已在扁平仓库工作树里带 <<<<<<< 标记，" >&2
  echo "  用任何编辑器改好（删掉标记、留最终正文）后重跑同步命令即可。" >&2
  exit 3
}

# 目录默认取工具配置（GWMW_CONFIG 或 config.json），可用 --flat/--content 覆盖
if [ -z "$FLAT" ] || [ -z "$CONTENT" ]; then
  DEFAULTS="$(node -e 'const c=require(process.argv[1]).load();process.stdout.write(c.wikiRepo+"\t"+c.contentDir)' "$ROOT/lib/config.js")"
  FLAT="${FLAT:-${DEFAULTS%%$'\t'*}}"
  CONTENT="${CONTENT:-${DEFAULTS##*$'\t'}}"
fi
[ -d "$FLAT" ] || { echo "✗ 扁平仓库不存在：$FLAT" >&2; exit 3; }
[ -d "$CONTENT" ] || { echo "✗ 内容树不存在：$CONTENT" >&2; exit 3; }

# 先把冲突写进 git（幂等），再列出清单；TSV：name / flat / content
LIST="$(node -e '
const [mod, flat, content] = process.argv.slice(1);
const cs = require(mod);
const names = new Set();
for (const n of cs.analyzePublish(flat, content, flat).conflict) names.add(n);
for (const o of cs.analyzeMirror(flat, content).overwrite) names.add(o.name);
for (const o of cs.analyzeFlatten(flat, content, flat).overwrite) names.add(o.name);
if (names.size) cs.makeGitMergeConflicts(flat, content, flat);
const byFlat = cs.contentNameMap(content).byFlat;
const rows = [...names].sort().map((n) => {
  const rel = byFlat.get(n);
  return [n, flat + "/" + n, rel ? content + "/" + rel : ""].join("\t");
});
process.stdout.write(rows.join("\n"));
' "$CS" "$FLAT" "$CONTENT")"

if [ -z "$LIST" ]; then
  echo "✅ 没有冲突：扁平仓库与 content/ 之间无需人工合并。"
  exit 0
fi

TOTAL="$(printf '%s\n' "$LIST" | wc -l | tr -d ' ')"
echo "扁平仓库：$FLAT"
echo "内容树  ：$CONTENT"
echo "共 $TOTAL 个冲突｜模式：$MODE"
if [ "$MODE" = merge ]; then
  echo "流程：内联 Accept / 合并编辑器「完成合并」→ 回来按回车开下一个"
else
  echo "流程：把两侧改成一致（右侧可直接编辑）→ 回来按回车开下一个"
fi

i=0
# 只有交互终端才等回车；管道/脚本调用（stdin 不是 tty）不等，直接跑完
INTERACTIVE=0
[ -t 0 ] && INTERACTIVE=1
# 清单放 fd 3，避免占掉 stdin，让 read 能正常吃到「回车 / s / q」
while IFS=$'\t' read -r name flatp contentp <&3; do
  [ -z "$name" ] && continue
  i=$((i + 1))
  echo ""
  echo "—— [$i/$TOTAL] $name"
  echo "   扁平 : $flatp"
  echo "   内容 : ${contentp:-（content/ 无此页）}"

  if [ "$MODE" = diff ]; then
    code --diff "$flatp" "${contentp:-/dev/null}" || true
    echo "   合并好后保存；两侧一致即可（重跑同步命令会自动放行）"
  else
    code "$flatp" || true
    echo "   用内联冲突按钮选边，或点「在合并编辑器中解决」→「完成合并」"
  fi

  if [ "$INTERACTIVE" = 1 ]; then
    printf '   完成后按回车开下一个（s=跳过剩下 q=退出）> '
    ans=""
    IFS= read -r ans || ans=""
    case "$ans" in
      s|S) echo "   （跳过剩下的）"; break ;;
      q|Q) echo "   （退出）"; break ;;
    esac
  fi
done 3<<< "$LIST"

echo ""
echo "✔ 结束。重跑一次命令让它收尾（进暂存区 + 同步回 content/）："
echo "   cd $ROOT && node bin/content-sync.js apply     # 只收尾（进暂存区 + 同步回 content/）"
echo "   或：node bin/publish.js \"说明\"                  # 直接发布"
