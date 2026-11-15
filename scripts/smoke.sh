#!/usr/bin/env bash
# dsh-llm-resilience 的真机冒烟：宿主 entry 真的挂上了，且启动日志没报它「没起来」。
#
# 这里只证明 entry 在组合树里（dormant 或已配链都适用）。真正的 fallback/重试/熔断/探活
# 行为需要独立 DSH_HOME + 本地假 OpenAI-compatible server，步骤见 DESIGN.md §11。
set -euo pipefail
export LC_ALL=C            # 启动日志里有非 UTF-8 字节，BSD grep 在 UTF-8 locale 下会报 Illegal byte sequence

PROFILE="${DSH_PROFILE:-web}"
ENTRY="llm-fallback"

dump="$(mktemp -t dsh-llm-resilience-dump.XXXXXX)"
trap 'rm -f "$dump"' EXIT
if ! dsh --profile "$PROFILE" --dump-config >"$dump" 2>/dev/null; then
  echo "dsh --profile $PROFILE --dump-config 失败"; exit 1
fi
grep -q "$ENTRY" "$dump" || {
  echo "组合树里找不到 $ENTRY —— 插件没挂上？装法：dsh plugin --profile $PROFILE add <插件目录>"; exit 1
}

LOG="${DSH_LOG_FILE:-}"
if [ -n "$LOG" ] && [ -f "$LOG" ]; then
  bad="$(grep -ac "$ENTRY.*never started" "$LOG" || true)"
  [ "$bad" = "0" ] || { echo "启动日志里有 $bad 条 $ENTRY 未启动告警：$LOG"; exit 1; }
  echo "✓ $ENTRY 在 $PROFILE 组合树里，启动日志无异常"
else
  echo "✓ $ENTRY 在 $PROFILE 组合树里（未提供 DSH_LOG_FILE，跳过启动日志检查）"
fi
