#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# 逐个打开冲突：一次一个，处理完回终端按回车打开下一个。
#
#   默认（--mode merge）三方合并编辑器：
#       code --merge <扁平> <内容> <共同祖先> <.content-sync/conflicts/<页>.diff>
#       点「完成合并」后结果直接写进 .diff → 重跑同步命令即复检并写回两侧
#   --mode diff  差异编辑器：
#       code --diff <扁平> <内容> → 把两侧改成一致 → 重跑同步命令即自动放行
#
# 用法：
#   bash tools/open-conflicts.sh [--mode merge|diff] [--flat DIR] [--content DIR]
#   npm run open-conflicts [-- --mode diff]
# 沙盒里把 PATH/GWMW_CONFIG 指向沙盒即可：
#   GWMW_CONFIG=/root/wiki/tmp/cs-playground/config.json bash tools/open-conflicts.sh
# ---------------------------------------------------------------------------
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"            # git-mediawiki-tools/
CS="$ROOT/bin/content-sync.js"

MODE=merge
FLAT=""
CONTENT=""

usage() {
  sed -n '2,15p' "$HERE/open-conflicts.sh" | sed 's/^# \{0,1\}//'
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
  echo "  没有 VS Code 也行：用任何文本编辑器把 .content-sync/conflicts/<页>.diff" >&2
  echo "  整份替换成该页最终正文并保存，然后重跑同步命令（见 README「方式一」）。" >&2
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

# 列出冲突（顺带刷新产物；人工改过的 diff 不会被覆盖），TSV：name / diff / flat / content
LIST="$(node -e '
const [mod, flat, content] = process.argv.slice(1);
const cs = require(mod);
const names = new Set();
for (const n of cs.analyzePublish(flat, content, flat).conflict) names.add(n);
for (const o of cs.analyzeMirror(flat, content).overwrite) names.add(o.name);
for (const o of cs.analyzeFlatten(flat, content, flat).overwrite) names.add(o.name);
const art = cs.materializeConflicts([...names].sort(), flat, content, { quiet: true });
const rows = (art ? art.files : []).map((f) => [f.name, f.diff || "", f.flat, f.content || ""].join("\t"));
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
  echo "流程：合并编辑器里合并 → 点「完成合并」（结果写进 .diff）→ 回来按回车开下一个"
else
  echo "流程：把两侧改成一致（右侧可直接编辑）→ 回来按回车开下一个"
fi

i=0
while IFS=$'\t' read -r name diff flatp contentp; do
  [ -z "$name" ] && continue
  i=$((i + 1))
  echo ""
  echo "—— [$i/$TOTAL] $name"

  if [ "$MODE" = diff ]; then
    echo "   扁平 : $flatp"
    echo "   内容 : ${contentp:-（content/ 无此页）}"
    code --diff "$flatp" "${contentp:-/dev/null}" || true
    echo "   合并好后保存；两侧一致即可（重跑同步命令会自动放行）"
  else
    if [ -z "$diff" ] || [ -z "$contentp" ] || [ ! -f "$flatp" ] || [ ! -f "$contentp" ]; then
      echo "   ⏭ 缺一侧 / 二进制页面，三方合并不适用：改跑 --mode diff，或用文本编辑器手改 .diff"
      continue
    fi
    base="$(mktemp -t cs-base-XXXXXX)"
    if ! git -C "$FLAT" show "HEAD:$name" > "$base" 2>/dev/null; then : > "$base"; fi
    rm -f "$diff"                      # 让合并编辑器从零生成结果（避免把 diff 原文当初值）
    echo "   扁平 : $flatp"
    echo "   内容 : $contentp"
    echo "   祖先 : $base（git show HEAD:$name）"
    echo "   结果 : $diff ← 完成后由工具复检并写回两侧"
    code --merge "$flatp" "$contentp" "$base" "$diff" || true
    echo "   → 合并后点「完成合并」（只关标签页不会写出结果）"
  fi

  printf '   完成后按回车开下一个（s=跳过剩下 q=退出）> '
  ans=""
  if ! IFS= read -r ans < /dev/tty 2>/dev/null; then
    IFS= read -r ans || ans=q
  fi
  case "$ans" in
    s|S) echo "   （跳过剩下的）"; break ;;
    q|Q) echo "   （退出）"; break ;;
  esac
done <<< "$LIST"

echo ""
echo "✔ 结束。重跑一次命令让它复检并写回两侧："
echo "   cd $ROOT && node bin/content-sync.js apply     # 只复检写回（有遗留冲突会报出来）"
echo "   或：node bin/publish.js \"说明\"                  # 直接发布"
