#!/usr/bin/env bash
# 端到端验证：**真的启动一个 dsh**，加载本插件，用假 provider 跑出真实故障场景。
#
# 为什么需要它（2026-11-25 教训）：
#   那天线上「没报错」，一度被当成「插件没问题」——实际上是把会话换成了直连
#   provider，链根本没被走到。**没有流量的绿是假绿。** 唯一可靠的判据是：让
#   链真的去请求一个行为已知的对端，然后看它是否做出了预期动作。
#
# 所以这里做三件事：
#   1. 独立 DSH_HOME（不碰用户的 profile、会话、凭据）；
#   2. 两个假 provider（fake-a / fake-b），行为由命令行给定；
#   3. 断言不只看最终文本，还看**谁答的**（正文里带端口）和**各自的请求次数**。
#
# 用法：
#   e2e/run.sh                       # 全部场景
#   e2e/run.sh baseline              # 只跑某一个
#   e2e/run.sh --list                # 列出场景
#
# 前置：本机已装 dsh（`dsh` 在 PATH 或 DSH_BIN 指定），Node 22+。
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(dirname "$HERE")"
DSH_BIN="${DSH_BIN:-$(command -v dsh || echo "$HOME/.npm-global/lib/node_modules/@deepseek-ai/dsh/lib/bin.js")}"
# 默认测**工作树源码**（link: 安装），因为跑 e2e 的时机就是「刚改完，想知道有没有破」。
# 想验证 registry 上那个包，设 PLUGIN_SPEC=@magic6/dsh-llm-resilience@<版本>。
PLUGIN_SPEC="${PLUGIN_SPEC:-$REPO}"

WORK="${E2E_WORK:-/tmp/dsh-llm-resilience-e2e}"
export DSH_HOME="$WORK/home"
export FAKE_KEY=dummy
export DEEPSEEK_API_KEY=dummy   # 内置 deepseek provider 缺 key 会挡住启动，与本次验证无关
export LC_ALL=C

PORT_A="${PORT_A:-8799}"
PORT_B="${PORT_B:-8798}"
STATE="$DSH_HOME/storages/llm-resilience/state.json"

pass=0; fail=0; failed_names=()

section() { printf '\n\033[1m══ %s\033[0m\n' "$*"; }
ok()   { pass=$((pass+1)); printf '  \033[32m✓\033[0m %s\n' "$*"; }
bad()  { fail=$((fail+1)); failed_names+=("$*"); printf '  \033[31m✗\033[0m %s\n' "$*"; }

# ── 一次性准备：独立 home + 临时 profile + 装插件 ───────────────────────────
prepare() {
	rm -rf "$WORK"
	mkdir -p "$WORK"

	# 先把 profile 建出来（dsh 首次启动会生成默认 profile），再写补丁层。
	( cd "$WORK" && "$DSH_BIN" --profile headless --dump-config >/dev/null 2>&1 || true )

	local prof="$DSH_HOME/profiles/headless"
	[ -d "$prof" ] || { echo "无法创建临时 profile: $prof" >&2; exit 1; }

	# 插件装进这个临时 profile —— 用 registry 上的版本，验证的是「用户装到的东西」，
	# 不是工作区里的源码。想测源码就设 PLUGIN_SPEC="$REPO"。
	# 安装失败时必须看得到 dsh/pnpm 的原话；吞掉输出会让 CI 只剩一句
	# 「插件安装失败」，无法区分网络、权限、engines、缺 pnpm。
	local install_log="$WORK/plugin-install.log"
	if ! ( cd "$prof" && "$DSH_BIN" plugin --profile headless add "$PLUGIN_SPEC" ) >"$install_log" 2>&1; then
		echo "插件安装失败: $PLUGIN_SPEC" >&2
		cat "$install_log" >&2
		exit 1
	fi

	cat > "$prof/cordis.patch.yml" <<YAML
# 端到端场景专用 profile：两个假 provider + resilience 链。
# 由 e2e/run.sh 生成，不要手改（每次跑都会覆盖）。
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      fake-a:
        displayName: Fake A
        apiKeyEnv: FAKE_KEY
        api: openai-completions
        baseURL: http://127.0.0.1:$PORT_A/v1
        models:
          - id: fake-model
            name: fake-model
            contextWindow: 128000
            input: [text]
            # 只声明 low/high：会话选 max 时，链必须在派发前就近映射成 high。
            # 不声明 off 是刻意的——「目标不支持所请求档位」才是真实场景。
            reasoningEfforts:
              low: low
              high: high
      fake-b:
        displayName: Fake B
        apiKeyEnv: FAKE_KEY
        api: openai-completions
        baseURL: http://127.0.0.1:$PORT_B/v1
        models:
          - id: fake-model
            name: fake-model
            contextWindow: 128000
            input: [text]
- id: llm-fallback
  name: '@magic6/dsh-llm-resilience'
  config:
    enabled: true
    route: fallback
    targets:
      - enabled: true
        provider: fake-a
        model: fake-model
        label: fake-a
        maxRetries: 2
        initialDelayMs: 50
        multiplier: 1.01
        maxDelayMs: 200
        jitterRatio: 0
      - enabled: true
        provider: fake-b
        model: fake-model
        label: fake-b
        maxRetries: 2
        initialDelayMs: 50
        multiplier: 1.01
        maxDelayMs: 200
        jitterRatio: 0
    breaker:
      failureThreshold: 2
      lockMs: 3000
      probe:
        enabled: true
        background: true
        timeoutMs: 5000
        # 刻意**不写** maxTokens：留空才走插件默认值（0.5.6 起是 256）。
        # 写死一个数字会让「默认值回归」这类 bug 测不出来 —— 2026-11-24 那次正是
        # 默认值 1 导致的，而它在配置里显式覆盖之后就看不出来了。
        prompt: ping
      stateFile: \$DSH_HOME/storages/llm-resilience/state.json
- id: agent-default-model
  config:
    provider: fallback
    model: auto
    # 用户线上场景：会话选了 max。合成模型必须接住宿主的预校验，
    # 再由每条 target 决定映射还是省略。
    reasoningEffort: max
YAML
}

# ── 单个场景 ────────────────────────────────────────────────────────────────
# $1 名称  $2 fake-a 脚本  $3 fake-b 脚本  $4 期望作答者（8799 / 8798 / error）
# $5 期望 fake-b 被请求数（用于断言「没有 fallback」；- 表示不检查）
# $6 期望错误码（仅 expect_src=error 时检查；- 表示不检查）
# $7 期望出现在输出里的片段（- 表示不检查）
run_case() {
	local name="$1" a_script="$2" b_script="$3" expect_src="$4" expect_b="$5"
	local expect_code="${6:--}" expect_text="${7:--}"
	rm -f "$STATE" "$WORK"/fake-*.log

	_start_servers "$a_script" "$b_script"
	local out code
	out="$( _answer 2>&1 | grep -vE '^\[llm-deepseek-api-key\]|^$' )"
	code=${PIPESTATUS[0]}
	# 上面是子 shell，PIPESTATUS 拿不到；直接用 dsh 自己的退出码重跑代价太大，
	# 改为看输出里有没有 `dsh: <CODE>` 这一行（失败时 dsh 一定打印它）。
	if grep -qE '^dsh: [A-Z_]+' <<<"$out"; then code=1; else code=0; fi
	_stop_servers

	local a_hits b_hits
	a_hits="$(grep -c 'action=' "$WORK/fake-a.log" 2>/dev/null | tr -d '\n' || true)"
	b_hits="$(grep -c 'action=' "$WORK/fake-b.log" 2>/dev/null | tr -d '\n' || true)"
	: "${a_hits:=0}"; : "${b_hits:=0}"

	local problems=()
	case "$expect_src" in
		8799) grep -q "pong-from-$PORT_A" <<<"$out" || problems+=("期望 fake-a 作答，实际: $(head -c 120 <<<"$out")") ;;
		8798) grep -q "pong-from-$PORT_B" <<<"$out" || problems+=("期望 fake-b 作答，实际: $(head -c 120 <<<"$out")") ;;
		error) [ "$code" -ne 0 ] || problems+=("期望失败，实际成功: $(head -c 120 <<<"$out")") ;;
	esac
	if [ "$expect_code" != "-" ]; then
		grep -q "dsh: $expect_code" <<<"$out" || problems+=("期望错误码 $expect_code，实际: $(head -c 120 <<<"$out")")
	fi
	if [ "$expect_text" != "-" ]; then
		grep -qF "$expect_text" <<<"$out" || problems+=("输出里缺片段 '$expect_text': $(head -c 160 <<<"$out")")
	fi
	if [ "$expect_b" != "-" ] && [ "$b_hits" != "$expect_b" ]; then
		problems+=("fake-b 期望被请求 $expect_b 次，实际 $b_hits 次")
	fi

	if [ "${#problems[@]}" -eq 0 ]; then
		ok "$name（a=$a_hits b=$b_hits）"
	else
		bad "$name"
		local p; for p in "${problems[@]}"; do printf '      %s\n' "$p"; done
	fi
}

# ── 假服务器 / dsh 调用的薄封装（跨轮次场景复用）─────────────────────────────
PA=""; PB=""
_start_servers() {
	SCRIPT="$1" PORT="$PORT_A" LOG_REQUESTS=1 node "$REPO/e2e/fake-llm-server.mjs" > "$WORK/fake-a.log" 2>&1 &
	PA=$!
	SCRIPT="$2" PORT="$PORT_B" LOG_REQUESTS=1 node "$REPO/e2e/fake-llm-server.mjs" > "$WORK/fake-b.log" 2>&1 &
	PB=$!
	sleep 0.8
}
_stop_servers() {
	[ -n "$PA" ] && kill "$PA" 2>/dev/null
	[ -n "$PB" ] && kill "$PB" 2>/dev/null
	wait "$PA" "$PB" 2>/dev/null
	PA=""; PB=""
}
_answer() {
	( cd "$WORK" && "$DSH_BIN" --profile headless headless "reply with exactly: pong" 2>&1 )
}

# ── 探活失败 -> 重新锁 ──────────────────────────────────────────────────────
run_probe_refail() {
	local name="探活失败 -> 重新锁一轮（不是放行）"
	rm -f "$STATE" "$WORK"/fake-*.log
	local problems=()

	# 第 1 轮：打满阈值
	_start_servers "500,500,500,500,500" "ok"; local o1; o1="$(_answer)"; _stop_servers
	grep -q "pong-from-$PORT_B" <<<"$o1" || problems+=("第 1 轮未 fallback")

	# 第 2 轮：锁过期后，探活本身也失败 -> 必须重新锁，而不是把 target 放回来
	sleep 3.5
	_start_servers "500" "ok"; local o2; o2="$(_answer)"; _stop_servers
	grep -q "pong-from-$PORT_B" <<<"$o2" || problems+=("探活失败后本轮不该用 fake-a")

	# 第 3 轮：重新锁上之后，fake-a 不该被请求
	_start_servers "ok" "ok"; local o3; o3="$(_answer)"; _stop_servers
	local hits3; hits3="$(grep -c 'action=' "$WORK/fake-a.log" 2>/dev/null | tr -d '\n')"
	: "${hits3:=0}"
	[ "$hits3" = "0" ] || problems+=("探活失败并被重新锁上后，fake-a 仍被请求 $hits3 次")
	grep -q "pong-from-$PORT_B" <<<"$o3" || problems+=("第 3 轮未用 fake-b")

	if [ "${#problems[@]}" -eq 0 ]; then ok "$name"; else
		bad "$name"; local p; for p in "${problems[@]}"; do printf '      %s\n' "$p"; done
	fi
}

# ── 内容已交付后断流 -> 宿主整步重放，不把两段内容拼给用户 ────────────────────
#
# 这里断言的东西和直觉相反，值得写清楚：fake-b **确实**会被请求，而且这是对的。
# `result.delivered` 为真时插件不原地换 target（那会把两段内容拼起来），而是
# 抛给宿主做整步重放；宿主重放同一步时，链按之前的记录跳过 fake-a、走 fake-b。
# 所以正确的断言不是「fake-b 一次不许被请求」，而是：
#   1. 用户最终看到的**只有一份**内容，且不含 fake-a 那段半成品；
#   2. fake-a 的本次请求没有静默重试（内容已交付时重试同样会重复）。
run_drop_after_delivery() {
	local name="内容已交付后断流 -> 交宿主整步重放，用户只看到一份完整内容"
	rm -f "$STATE" "$WORK"/fake-*.log
	local problems=()

	_start_servers "drop" "ok"; local out; out="$(_answer)"; _stop_servers

	if grep -q 'PARTIAL-FROM-A' <<<"$out"; then
		problems+=("用户看到了 fake-a 那半截内容（应该由宿主丢弃）: $(head -c 120 <<<"$out")")
	fi
	grep -q "pong-from-$PORT_B" <<<"$out" || problems+=("重放后没有走到 fake-b: $(head -c 120 <<<"$out")")
	# 只允许一份内容：两个 target 的正文不能同时出现
	local n_a n_b
	n_a=$(grep -c 'PARTIAL-FROM-A' <<<"$out" || true)
	n_b=$(grep -c "pong-from-$PORT_B" <<<"$out" || true)
	[ "${n_a:-0}" = "0" ] && [ "${n_b:-0}" = "1" ] || problems+=("内容不是恰好一份（A=$n_a 次, B=$n_b 次）")

	if [ "${#problems[@]}" -eq 0 ]; then ok "$name"; else
		bad "$name"; local p; for p in "${problems[@]}"; do printf '      %s\n' "$p"; done
	fi
}
# ── 工具调用吐到一半就断 -> 缓冲必须挡住半成品 ──────────────────────────────
#
# 插件把 tool-call 的 block-start/delta 压到 block-end 才交付，所以「参数还没吐完
# 就断线」这种故障对宿主是不可见的：宿主该看到一次干净的失败并重试/回退，而不是
# 拿到一个 arguments 被截断的调用去执行。
run_drop_mid_tool() {
	local name="工具调用吐一半断流 -> 宿主看不到半成品调用"
	rm -f "$STATE" "$WORK"/fake-*.log
	local problems=()

	_start_servers "drop-mid-tool" "ok"; local out; out="$(_answer)"; _stop_servers

	# 半截 arguments 绝不能出现在输出里（出现说明缓冲漏了）
	if grep -q 'HALF' <<<"$out"; then
		problems+=("宿主看到了被截断的工具参数: $(head -c 140 <<<"$out")")
	fi
	grep -q "pong-from-$PORT_B" <<<"$out" || problems+=("未回退到 fake-b: $(head -c 140 <<<"$out")")
	# 不能以工具执行错误收场
	if grep -qiE 'tool.*(invalid|failed|malformed)|INVALID_ARGUMENT' <<<"$out"; then
		problems+=("出现了工具调用错误: $(head -c 140 <<<"$out")")
	fi

	if [ "${#problems[@]}" -eq 0 ]; then ok "$name"; else
		bad "$name"; local p; for p in "${problems[@]}"; do printf '      %s\n' "$p"; done
	fi
}

# ── 思考强度 max -> 目标只有 low/high 时就近映射 ─────────────────────────────
#
# 这个场景抓的是 2026-11-25 的线上 bug：宿主在进入适配器之前，会用合成模型的
# reasoning 元数据校验 reasoningEffort。合成模型若只声明 target 能力的交集，
# 一个手动添加、没写 thinking 配置的模型就会让整条链拒绝 max。
run_effort_mapping() {
	local name="思考强度 max -> 目标只支持 low/high 时就近映射为 high"
	rm -f "$STATE" "$WORK"/fake-*.log
	local problems=()

	_start_servers "ok" "ok"; local out; out="$(_answer)"; _stop_servers
	grep -q "pong-from-$PORT_A" <<<"$out" || problems+=("fake-a 未作答: $(head -c 140 <<<"$out")")
	if grep -qiE 'UNSUPPORTED_REASONING_EFFORT|does not support reasoning' <<<"$out"; then
		problems+=("宿主在进入链之前拒绝了 max: $(head -c 180 <<<"$out")")
	fi
	local line; line="$(grep 'action=ok' "$WORK/fake-a.log" | head -1)"
	[ -n "$line" ] || problems+=("fake-a 没收到真实请求")
	grep -q 'effort=high' <<<"$line" || problems+=("max 未映射成 high: $line")
	grep -q 'effort=max' <<<"$line" && problems+=("把不支持的 max 原样发给了目标: $line")

	if [ "${#problems[@]}" -eq 0 ]; then ok "$name"; else
		bad "$name"; local p; for p in "${problems[@]}"; do printf '      %s\n' "$p"; done
	fi
}

# ── 思考强度 max -> 目标没有 thinking 元数据时省略参数 ───────────────────────
#
# 用户手动添加的 glm-5.4 就是这种目标：直接调用走默认，能用；链不能因为
# 会话选了 max 就把它变成不可用。适配器应省略 reasoningEffort，让目标用默认。
run_effort_omit() {
	local name="思考强度 max -> 无 thinking 元数据的目标省略参数，不硬失败"
	rm -f "$STATE" "$WORK"/fake-*.log
	local problems=()

	_start_servers "400upstream" "ok"; local out; out="$(_answer)"; _stop_servers
	grep -q "pong-from-$PORT_B" <<<"$out" || problems+=("未回退到 fake-b: $(head -c 140 <<<"$out")")
	if grep -qiE 'UNSUPPORTED_REASONING_EFFORT|does not support reasoning' <<<"$out"; then
		problems+=("无 thinking 的目标被 max 直接判死: $(head -c 180 <<<"$out")")
	fi
	local line; line="$(grep 'action=ok' "$WORK/fake-b.log" | head -1)"
	[ -n "$line" ] || problems+=("fake-b 没收到真实请求")
	grep -q 'effort=-' <<<"$line" || problems+=("无 thinking 的目标仍收到了 effort 参数: $line")

	if [ "${#problems[@]}" -eq 0 ]; then ok "$name"; else
		bad "$name"; local p; for p in "${problems[@]}"; do printf '      %s\n' "$p"; done
	fi
}

# ── 跨轮次场景：熔断锁 -> 跳过 -> 到期探活恢复 ───────────────────────────────
run_breaker_lifecycle() {
	local name="熔断生命周期：锁 -> 跳过 -> 到期探活 -> 恢复"
	rm -f "$STATE" "$WORK"/fake-*.log

	local PA="" PB=""
	local problems=()

	# 第 1 轮：打满熔断阈值
	_start_servers "500,500,500,500,500" "ok"; local o1; o1="$(_answer)"; _stop_servers
	grep -q "pong-from-$PORT_B" <<<"$o1" || problems+=("第 1 轮未 fallback 到 fake-b")
	grep -q 'fake-a' "$STATE" 2>/dev/null || problems+=("第 1 轮后状态文件里没有 fake-a 的锁")

	# 第 2 轮：锁未过期，fake-a 一次都不该被请求
	_start_servers "ok" "ok"; local o2; o2="$(_answer)"; _stop_servers
	local hits2; hits2="$(grep -c 'action=' "$WORK/fake-a.log" 2>/dev/null | tr -d '\n')"
	: "${hits2:=0}"
	[ "$hits2" = "0" ] || problems+=("锁未过期时 fake-a 仍被请求 $hits2 次")

	# 第 3 轮：等锁过期。`background: true` 的语义是「本轮跳过 half-open target，
	# 在后台探活，探活成功后**下一次**才恢复使用」——所以本轮仍由 fake-b 作答，
	# 但 fake-a 必须收到一条探活请求（形状：无 tools、msgs=1）。
	sleep 3.5
	_start_servers "ok" "ok"; local o3; o3="$(_answer)"; _stop_servers
	local probe_line; probe_line="$(grep 'action=' "$WORK/fake-a.log" | head -1)"
	if [ -z "$probe_line" ]; then
		problems+=("锁过期后 fake-a 没收到任何请求（探活没发生）")
	else
		grep -q 'tools=0' <<<"$probe_line" || problems+=("fake-a 收到的不是探活请求: $probe_line")
		# 探活预算必须够 —— maxTokens:1 正是 2026-11-24 那个 bug
		grep -q 'max_tokens=1 ' <<<"$probe_line" && problems+=("探活预算仍是 1（0.5.6 之前的老 bug）")
	fi
	grep -q "pong-from-$PORT_B" <<<"$o3" || problems+=("后台探活期间本轮不该用 fake-a，输出: $(head -c 100 <<<"$o3")")

	# 第 4 轮：探活已成功，fake-a 应恢复使用
	_start_servers "ok" "ok"; local o4; o4="$(_answer)"; _stop_servers
	grep -q "pong-from-$PORT_A" <<<"$o4" || problems+=("探活成功后 fake-a 未被恢复使用，输出: $(head -c 100 <<<"$o4")")
	# 只看 entries：`cleared` 里出现 fake-a 是**正常**的（那是成功后的 tombstone，
	# 用来压掉其它进程写下的旧锁）。用 grep 整个文件会把正常情况误判成故障。
	python3 - "$STATE" <<'PY' || problems+=("恢复后状态文件 entries 里 fake-a 仍有锁")
import json, sys
d = json.load(open(sys.argv[1]))
sys.exit(1 if any(k.startswith("fake-a") for k in d.get("entries", {})) else 0)
PY

	if [ "${#problems[@]}" -eq 0 ]; then ok "$name"; else
		bad "$name"; local p; for p in "${problems[@]}"; do printf '      %s\n' "$p"; done
	fi
}

SCENARIOS=(baseline upstream400 genuine400 transient500 exhausted malformed effort-map effort-omit probe-refail drop drop-mid-tool breaker)

main() {
	section "准备：独立 DSH_HOME + 临时 profile + 装插件"
	prepare
	echo "  DSH_HOME=$DSH_HOME"
	echo "  插件=$PLUGIN_SPEC"
	echo "  dsh=$DSH_BIN"

	section "场景"
	local only="${1:-}"
	if [ -z "$only" ] || [ "$only" = baseline ]; then
		run_case "基线：两个 target 都正常，fake-a 直接作答（fake-b 一次都不该被请求）" ok ok 8799 0
	fi
	if [ -z "$only" ] || [ "$only" = upstream400 ]; then
		run_case "网关包装 400（upstream_error）-> 必须 fallback 而不是整轮失败" 400upstream ok 8798 -
	fi
	if [ -z "$only" ] || [ "$only" = genuine400 ]; then
		run_case "真·请求错误 400 -> 必须 fail fast，不换 target" 400genuine ok error -
	fi
	if [ -z "$only" ] || [ "$only" = transient500 ]; then
		run_case "瞬时 500 -> 重试后 fallback" 500 ok 8798 -
	fi
	if [ -z "$only" ] || [ "$only" = exhausted ]; then
		run_case "全部 target 都失败 -> FALLBACK_EXHAUSTED 且保留最后一次真实失败" \
		500 500 error - FALLBACK_EXHAUSTED "last: "
	fi
	if [ -z "$only" ] || [ "$only" = malformed ]; then
		run_case "并行工具调用被拼成一个块（MALFORMED_RESPONSE）-> 不整轮作废" malformed-tools ok 8798 -
	fi
	if [ -z "$only" ] || [ "$only" = effort-map ]; then
		run_effort_mapping
	fi
	if [ -z "$only" ] || [ "$only" = effort-omit ]; then
		run_effort_omit
	fi
	if [ -z "$only" ] || [ "$only" = probe-refail ]; then
		run_probe_refail
	fi
	if [ -z "$only" ] || [ "$only" = drop ]; then
		run_drop_after_delivery
	fi
	if [ -z "$only" ] || [ "$only" = drop-mid-tool ]; then
		run_drop_mid_tool
	fi
	if [ -z "$only" ] || [ "$only" = breaker ]; then
		run_breaker_lifecycle
	fi

	printf '\n\033[1m结果：%d 通过，%d 失败\033[0m\n' "$pass" "$fail"
	if [ "$fail" -gt 0 ]; then
		printf '失败项：\n'; printf '  - %s\n' "${failed_names[@]}"
		return 1
	fi
	return 0
}

case "${1:-}" in
	--list) printf '%s\n' "${SCENARIOS[@]}"; exit 0 ;;
	-h|--help) sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
	*) main "${1:-}" ;;
esac
