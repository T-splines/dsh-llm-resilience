/**
 * Browser half of dsh-llm-resilience: the fallback-chain card on the plugin's own page
 * (Plugins → Installed → @magic6/dsh-llm-resilience), registered into `plugins.bundle.config`.
 *
 * Served verbatim (no build step), so the few policy formulas this card needs —
 * nominal backoff and jitter bounds — are inlined here. `test/client.test.js`
 * pins them against `lib/policy.js`, so the preview cannot drift from what the
 * adapter actually waits.
 *
 * Every field writes through `ctx.configForms.get('llm-fallback')`, the profile
 * entry id whose `Config` owns this document. A non-loopback browser only gets a
 * memory view; the card says so and renders no values rather than passing the
 * plugin defaults off as the host's policy.
 *
 * @module dsh-llm-resilience/client
 */

window.__ModuleLoader__.load({
	id: '@magic6/dsh-llm-resilience',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		const react = require('react');
		const jsx = require('react/jsx-runtime');

		const NS = 'llm-fallback';
		/** npm 包名：`plugins.bundle.config` 用它与「已安装插件」里的行配对。 */
		const PACKAGE_NAME = '@magic6/dsh-llm-resilience';
		const DEFAULT_ROUTE = 'fallback';

		const zh = {
			title: '模型回退链',
			hint: '这条合成 provider 按顺序尝试下面的目标。每个 target 有独立的重试预算和退避；连续失败会熔断，锁到期后先探活再恢复。',
			enabled: '启用插件',
			route: '合成 route',
			routeHint: 'route 在插件加载时固定；改名需要修改配置并重启 dsh。',
			targets: '目标链',
			targetCount: '{total} 条目标 · {enabled} 条参与',
			targetsEmpty: '链为空：合成 route 保持 dormant，不提供模型。至少添加一个目标后才会接管请求。',
			addTarget: '添加目标',
			enableTarget: '参与链',
			labelPlaceholder: '显示名（可选）',
			provider: 'provider',
			model: 'model',
			maxRetries: '重试次数',
			initialDelay: '首次等待 (ms)',
			multiplier: '倍率',
			maxDelay: '等待上限 (ms)',
			jitter: '抖动 (0–1)',
			plan: '重试计划',
			planTitle: '重试计划',
			planSub: '首次请求失败后，最多再试 {n} 次：',
			planNone: '重试次数为 0：首次失败后直接进入下一个目标。',
			planRow: '第 {n} 次',
			planRange: '{low} – {high}',
			planJitterNote: '每行是四舍五入后的名义等待；实际值在抖动范围内随机。',
			planTotal: '名义总等待 {total}',
			planTruncated: '……共 {n} 次重试',
			moveUp: '上移',
			moveDown: '下移',
			remove: '移除',
			disable: '已禁用',
			breaker: '熔断锁',
			breakerHint: '按 provider + model 独立记账。连续失败达到阈值后锁定；锁到期后先发一个最小 chat 探活，成功才恢复使用，失败再锁一轮。',
			failureThreshold: '失败阈值',
			lockMinutes: '锁定时长（分钟）',
			probe: '锁到期先探活',
			probeBackground: '锁到期在后台探活',
			probeBackgroundHint: '开启后，锁到期的目标在本次请求里直接跳过，探活放到后台跑；下一次请求使用探活结果，当前请求不会为了等探活而变慢。',
			probeTimeout: '探活超时 (ms)',
			probeMaxTokens: '探活 maxTokens',
			probePrompt: '探活 prompt',
			limits: '单次请求预算',
			limitsHint: '跨 target、跨重试累计；重试等待也计入总时限。0 表示不限制。',
			maxTotalMs: '总时限 (ms)',
			maxAttempts: '最多请求数',
			live: '运行状态',
			liveHint: '每 4 秒从主机读取一次熔断状态；这里只读。',
			liveEmpty: '还没有运行状态：插件在这个进程里尚未发起过请求，或链为空。',
			liveDisabled: '插件已停用，运行状态可能来自停用之前。',
			liveUpdated: '更新于 {age}前',
			liveFailureCount: '连败 {n}',
			liveLockCount: '累计锁 {n} 次',
			liveRemaining: '剩余 {time}',
			liveError: '读取运行状态失败：{message}',
			liveStateClosed: '正常',
			liveStateOpen: '已锁定',
			liveStateHalfOpen: '待探活',
			liveStateProbing: '探活中',
			liveStateUnknown: '未知',
			stateFile: '状态文件',
			stateFileHint: '只存熔断计数与时间，不写密钥。',
			toolCalls: '工具调用',
			retryMalformed: '重试「模型输出损坏」的工具调用',
			retryMalformedHint: '只覆盖工具参数 JSON 非法等 LLM 输出问题——重发整个请求是安全的。工具真正执行失败（文件不存在、命令非零退出）不会被重试，因为可能有副作用。',
			save: '保存',
			discard: '放弃改动',
			unsaved: '有未保存的改动',
			loading: '正在读取配置…',
			catalogLoading: '正在读取会话模型目录…',
			catalogFailed: '模型目录加载失败，provider / model 暂时无法选择；修好后才能保存。',
			catalogRetry: '重新加载目录',
			catalogBlocked: '模型目录未就绪，暂时不能保存。',
			selectPlaceholder: '请选择',
			notInCatalog: '（不在目录中）',
			unavailable: '这个浏览器读不到主机上的 fallback 配置（dsh 只给非环回地址内存态视图）。为避免把默认值冒充成真值，这里不显示任何字段；请在本机用 127.0.0.1 打开设置页。',
			readOnly: '主机配置对这台客户端只读：下面是真实生效值，但不能在这里修改。',
			writeRefused: '写入未被主机接受：配置没有保存。',
			invalid: '有字段不合法，修好后再保存：',
			saved: '已保存',
			errProvider: '第 {n} 条：provider 不能为空',
			errModel: '第 {n} 条：model 不能为空',
			errMaxRetries: '第 {n} 条：重试次数必须是 ≥0 的整数',
			errInitialDelay: '第 {n} 条：首次等待必须 > 0',
			errMultiplier: '第 {n} 条：倍率必须 > 1',
			errMaxDelay: '第 {n} 条：等待上限必须 ≥ 首次等待',
			errJitter: '第 {n} 条：抖动必须在 0–1 之间',
			errSelf: '第 {n} 条：provider 不能等于合成 route',
			errDuplicate: '第 {n} 条：与前面的目标重复',
			errFailureThreshold: '失败阈值必须是 ≥1 的整数',
			errLock: '锁定时长必须 > 0 分钟',
			errProbeTimeout: '探活超时必须 > 0',
			errProbeMaxTokens: '探活 maxTokens 必须是 ≥1 的整数',
			errProbePrompt: '探活 prompt 不能为空',
			errMaxTotalMs: '总时限必须是 ≥0 的毫秒数',
			errMaxAttempts: '最多请求数必须是 ≥0 的整数',
			errProviderUnknown: '第 {n} 条：provider 不在当前会话的模型目录中',
			errModelUnknown: '第 {n} 条：model 不在该 provider 的目录中',
			errStateFile: '状态文件路径不能为空',
		};

		const en = {
			title: 'Model fallback chain',
			hint: 'This synthetic provider walks the targets below in order. Each target keeps its own retry budget and backoff; repeated failures trip a circuit breaker, and a lock is re-probed before the target is used again.',
			enabled: 'Enable plugin',
			route: 'Synthetic route',
			routeHint: 'The route is fixed when the plugin loads; renaming it requires a config edit and a dsh restart.',
			targets: 'Target chain',
			targetCount: '{total} target(s) · {enabled} enabled',
			targetsEmpty: 'The chain is empty: the synthetic route stays dormant and serves no models. Add at least one target to take over requests.',
			addTarget: 'Add target',
			enableTarget: 'In chain',
			labelPlaceholder: 'Display name (optional)',
			provider: 'provider',
			model: 'model',
			maxRetries: 'Retries',
			initialDelay: 'First wait (ms)',
			multiplier: 'Multiplier',
			maxDelay: 'Wait cap (ms)',
			jitter: 'Jitter (0–1)',
			plan: 'Retry plan',
			planTitle: 'Retry plan',
			planSub: 'After the first request fails, up to {n} more attempt(s):',
			planNone: 'Zero retries: the first failure moves straight to the next target.',
			planRow: 'Retry {n}',
			planRange: '{low} – {high}',
			planJitterNote: 'Each row is the rounded nominal wait; the actual wait is randomized inside the jitter range.',
			planTotal: 'Nominal total {total}',
			planTruncated: '…{n} retries in total',
			moveUp: 'Move up',
			moveDown: 'Move down',
			remove: 'Remove',
			disable: 'disabled',
			breaker: 'Circuit breaker',
			breakerHint: 'Tracked per provider + model. After enough consecutive failures the target is locked; when the lock expires a minimal chat probes it, and it only returns if the probe succeeds.',
			failureThreshold: 'Failure threshold',
			lockMinutes: 'Lock duration (minutes)',
			probe: 'Probe before reuse',
			probeBackground: 'Probe expired locks in the background',
			probeBackgroundHint: 'When on, an expired target is skipped by the current request and probed in the background; the next request uses the probe result, so the current one never waits for it.',
			probeTimeout: 'Probe timeout (ms)',
			probeMaxTokens: 'Probe maxTokens',
			probePrompt: 'Probe prompt',
			limits: 'Per-request budget',
			limitsHint: 'Accumulated across targets and retries; retry waits count toward the deadline. 0 means unlimited.',
			maxTotalMs: 'Total deadline (ms)',
			maxAttempts: 'Max upstream requests',
			live: 'Live state',
			liveHint: 'Reads breaker state from the host every 4 seconds; read-only.',
			liveEmpty: 'No runtime state yet: the plugin has not served a request in this process, or the chain is empty.',
			liveDisabled: 'The plugin is disabled; state may predate the switch.',
			liveUpdated: 'Updated {age} ago',
			liveFailureCount: '{n} consecutive',
			liveLockCount: '{n} lock(s)',
			liveRemaining: '{time} left',
			liveError: 'Cannot read runtime state: {message}',
			liveStateClosed: 'healthy',
			liveStateOpen: 'locked',
			liveStateHalfOpen: 'probe pending',
			liveStateProbing: 'probing',
			liveStateUnknown: 'unknown',
			stateFile: 'State file',
			stateFileHint: 'Stores breaker counters and timestamps only — never credentials.',
			toolCalls: 'Tool calls',
			retryMalformed: 'Retry tool calls with malformed model output',
			retryMalformedHint: 'Covers LLM output problems such as invalid tool-argument JSON, where replaying the whole request is safe. Real tool-execution failures (missing file, non-zero command) are not retried because they may have side effects.',
			save: 'Save',
			discard: 'Discard',
			unsaved: 'Unsaved changes',
			loading: 'Reading configuration…',
			catalogLoading: 'Reading the session model catalog…',
			catalogFailed: 'The model catalog failed to load, so provider / model cannot be chosen; saving stays disabled until it recovers.',
			catalogRetry: 'Reload catalog',
			catalogBlocked: 'The model catalog is not ready; saving is disabled.',
			selectPlaceholder: 'Select…',
			notInCatalog: '(not in catalog)',
			unavailable: 'This browser cannot read the host fallback configuration (dsh gives non-loopback clients a memory view only). No fields are shown, because plugin defaults are not the deployed truth; open Settings on 127.0.0.1 instead.',
			readOnly: 'The host configuration is read-only for this client: the values below are real, but cannot be edited here.',
			writeRefused: 'The host refused the write: nothing was saved.',
			invalid: 'Some fields are invalid; fix them before saving:',
			saved: 'Saved',
			errProvider: 'Target {n}: provider must not be empty',
			errModel: 'Target {n}: model must not be empty',
			errMaxRetries: 'Target {n}: retries must be an integer ≥ 0',
			errInitialDelay: 'Target {n}: first wait must be > 0',
			errMultiplier: 'Target {n}: multiplier must be > 1',
			errMaxDelay: 'Target {n}: wait cap must be ≥ the first wait',
			errJitter: 'Target {n}: jitter must be between 0 and 1',
			errSelf: 'Target {n}: provider must not equal the synthetic route',
			errDuplicate: 'Target {n}: duplicates an earlier target',
			errFailureThreshold: 'Failure threshold must be an integer ≥ 1',
			errLock: 'Lock duration must be > 0 minutes',
			errProbeTimeout: 'Probe timeout must be > 0',
			errProbeMaxTokens: 'Probe maxTokens must be an integer ≥ 1',
			errProbePrompt: 'Probe prompt must not be empty',
			errMaxTotalMs: 'Total deadline must be a number of ms ≥ 0',
			errMaxAttempts: 'Max upstream requests must be an integer ≥ 0',
			errProviderUnknown: 'Target {n}: provider is not in this session model catalog',
			errModelUnknown: 'Target {n}: model is not offered by that provider',
			errStateFile: 'State file path must not be empty',
		};

		/**
		 * Shared config-card kit (`cc*` classes) — the plugin-form layout vocabulary
		 * for settings pages, expressed only in `--dsw-alias-*` theme tokens.
		 *
		 * Provenance: grown inside dsh-compaction-control's card, promoted to the
		 * shared standard (WorkSpaces/ui-unification-plan-2026-10-26.md). This exact
		 * text is vendored into every hand-written client that renders a config
		 * card; `plugin-devkit/ui-kit/check.mjs` fails when a copy drifts. The
		 * injector is idempotent on the shared `data-plugin-css="dsh-ui-kit"` id, so
		 * the first client to boot owns the single <style> tag and the rest no-op —
		 * no plugin may grow a runtime dependency on another plugin's stylesheet.
		 */
		const UI_KIT_CSS = [
			'.ccWrap{display:flex;flex-direction:column;gap:8px;padding:12px 0}',
			'.ccTitle{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500}',
			'.ccHint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}',
			'.ccRow{display:flex;align-items:center;gap:10px}',
			'.ccLabel{color:var(--dsw-alias-label-secondary);flex:1;font-size:13px}',
			'.ccInput{border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);height:32px;font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 10px;width:104px;font-size:13px;font-variant-numeric:tabular-nums}',
			'.ccInput:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}',
			'.ccInputInvalid{border-color:var(--dsw-alias-label-error)}',
			'.ccInputWide{width:170px}',
			'.ccReset{font:inherit;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;padding:0;font-size:12px}',
			'.ccReset:hover:not(:disabled){color:var(--dsw-alias-label-primary)}',
			'.ccReset:disabled{cursor:default;opacity:.5}',
			'.ccError{color:var(--dsw-alias-label-error);margin:0;font-size:12px}',
			'.ccReadonly{color:var(--dsw-alias-label-secondary);font-size:13px}',
			'.ccSelect{border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);height:32px;font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 8px;max-width:240px;font-size:13px;cursor:pointer}',
			'.ccSelect:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}',
			'.ccSelect:disabled{cursor:default;opacity:.6}',
			'.ccCheck{width:16px;height:16px;accent-color:var(--dsw-alias-brand-primary);cursor:pointer;flex:none;margin:0}',
			'.ccSubHint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5;padding-left:26px}',
			'.ccList{margin:0;padding-left:1.2em;max-height:9em;overflow:auto;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.5}',
			// 回退链是一张有序表，缩进让它读起来像“主模型之下的第 1、2、3 选择”，
			// 而不是一组与阈值平级的设置。
			'.ccChain{display:flex;flex-direction:column;gap:6px;border-left:2px solid var(--dsw-alias-border-l4);padding-left:10px;margin:4px 0}',
			'.ccChainRow{gap:8px}',
			'.ccChainIndex{color:var(--dsw-alias-label-tertiary);font-size:12px;min-width:14px}',
			'.ccChainValue{flex:1;font-size:13px;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
		].join('');

		if (
			typeof document !== 'undefined' &&
			document.querySelector('style[data-plugin-css="dsh-ui-kit"]') === null
		) {
			const uiKitTag = document.createElement('style');
			uiKitTag.dataset.pluginCss = 'dsh-ui-kit';
			uiKitTag.textContent = UI_KIT_CSS;
			document.head.appendChild(uiKitTag);
		}

		const css = [
			'.lfHead{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
			'.lfRoute{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-3);border:.5px solid var(--dsw-alias-border-l4);border-radius:6px;padding:1px 6px;font-size:11px;font-variant-numeric:tabular-nums}',
			'.lfSection{display:flex;flex-direction:column;gap:8px;border-top:.5px solid var(--dsw-alias-border-l4);padding-top:10px;margin-top:2px}',
			'.lfSectionHead{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}',
			'.lfCount{color:var(--dsw-alias-label-tertiary);font-size:11px;margin-left:auto}',
			'.lfTarget{display:flex;flex-direction:column;gap:8px;padding:10px;border:.5px solid var(--dsw-alias-border-l4);border-radius:10px;background:var(--dsw-alias-bg-layer-2);position:relative}',
			'.lfTargetOff{opacity:.6}',
			'.lfTargetHead{display:flex;align-items:center;gap:8px}',
			'.lfLabelInput{flex:1;width:auto;min-width:120px}',
			'.lfFields{display:flex;flex-wrap:wrap;gap:10px}',
			'.lfField{display:flex;flex-direction:column;gap:3px;font-size:11px;color:var(--dsw-alias-label-tertiary)}',
			'.lfField .ccInput{width:96px}',
			'.lfFieldWide .ccInput{width:160px}',
			'.lfFieldWide .lfStateInput{width:300px}',
			'.lfSelect{width:180px;max-width:180px;text-overflow:ellipsis}',
			'.lfFoot{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
			'.lfSummary{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.5}',
			'.lfTipWrap{position:relative;display:inline-flex}',
			'.lfTipPanel{position:fixed;z-index:200;box-sizing:border-box;width:260px;max-height:340px;overflow:auto;background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l2);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent);border-radius:10px;padding:10px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);text-align:left}',
			'.lfTipTitle{margin:0 0 2px;color:var(--dsw-alias-label-primary);font-size:12px;font-weight:500}',
			'.lfTipSub{margin:0 0 6px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.5}',
			'.lfTipRow{display:flex;align-items:baseline;justify-content:space-between;gap:16px;font-variant-numeric:tabular-nums}',
			'.lfTipVal{color:var(--dsw-alias-label-primary)}',
			'.lfTipFoot{margin:6px 0 0;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.5}',
			'.lfActions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
			'.lfPrimary{font:inherit;font-size:12px;height:28px;padding:0 12px;border-radius:8px;border:none;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-inverted);cursor:pointer}',
			'.lfPrimary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}',
			'.lfPrimary:disabled{cursor:default;opacity:.5}',
			'.lfOffTag{color:var(--dsw-alias-label-tertiary);font-size:11px;border:.5px solid var(--dsw-alias-border-l4);border-radius:999px;padding:0 6px}',
			'.lfLiveRows{display:flex;flex-direction:column;gap:6px}',
			'.lfLiveRow{display:flex;align-items:baseline;gap:8px;font-size:12px;font-variant-numeric:tabular-nums}',
			'.lfLiveDot{width:8px;height:8px;border-radius:999px;flex:none;align-self:center;background:var(--dsw-alias-label-tertiary)}',
			'.lfLiveDotClosed{background:var(--dsw-alias-state-success-primary)}',
			'.lfLiveDotHalfOpen,.lfLiveDotProbing{background:var(--dsw-alias-state-warn-primary)}',
			'.lfLiveDotOpen{background:var(--dsw-alias-state-error-primary)}',
			'.lfLiveName{color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:40%}',
			'.lfLiveState{color:var(--dsw-alias-label-secondary)}',
			'.lfLiveDetail{color:var(--dsw-alias-label-secondary);margin-left:auto}',
			'.lfLiveCounts{color:var(--dsw-alias-label-tertiary)}',
		].join('');

		if (
			typeof document !== 'undefined' &&
			document.querySelector('style[data-plugin-css="dsh-llm-resilience"]') === null
		) {
			const tag = document.createElement('style');
			tag.dataset.plugin = 'dsh-llm-resilience';
			tag.dataset.pluginCss = 'dsh-llm-resilience';
			tag.textContent = css;
			document.head.appendChild(tag);
		}

		// ── 纯函数：与 host 侧 lib/policy.js 同一套公式 ──────────────────────
		// 这段文件被原样下发，不能 import；`test/client.test.js` 用 policy.js 的
		// nominalSchedule 钉住这里的计算，任何一边改了公式都会失败。

		const DEFAULTS = Object.freeze({
			maxRetries: 5,
			initialDelayMs: 1500,
			multiplier: 2,
			maxDelayMs: 20000,
			jitterRatio: 0.3,
			failureThreshold: 5,
			lockMs: 3600000,
			probeTimeoutMs: 10000,
			probeMaxTokens: 256,
			probePrompt: 'ping',
			probeBackground: false,
			maxTotalMs: 600000,
			maxAttempts: 50,
			stateFile: '$DSH_HOME/storages/llm-resilience/state.json',
		});

		/** 预览最多渲染多少行；超出部分只显示总数，避免一个巨大的数字卡住页面。 */
		const PREVIEW_LIMIT = 50;

		/** 把毫秒格式化成紧凑的可读时长；保留到 0.1s / 0.1min。 */
		function formatMs(ms) {
			const value = Number(ms);
			if (!Number.isFinite(value) || value < 0) return '—';
			if (value < 1000) return `${Math.round(value)}ms`;
			if (value < 60000) {
				const seconds = Math.round(value / 100) / 10;
				return `${seconds}s`;
			}
			const minutes = Math.round(value / 6000) / 10;
			return `${minutes}min`;
		}

		/** 运行状态的“多久之前”；只用于粗粒度新鲜度，不做倒计时。 */
		function formatAge(ms) {
			const value = Number(ms);
			if (!Number.isFinite(value) || value < 0) return '—';
			if (value < 1000) return '<1s';
			if (value < 60000) return `${Math.round(value / 1000)}s`;
			return `${Math.round(value / 60000)}min`;
		}

		const LIVE_STATE_KEYS = Object.freeze({
			closed: 'liveStateClosed',
			open: 'liveStateOpen',
			'half-open': 'liveStateHalfOpen',
			probing: 'liveStateProbing',
		});

		function liveDotClass(state) {
			if (state === 'closed') return 'lfLiveDot lfLiveDotClosed';
			if (state === 'open') return 'lfLiveDot lfLiveDotOpen';
			if (state === 'half-open') return 'lfLiveDot lfLiveDotHalfOpen';
			if (state === 'probing') return 'lfLiveDot lfLiveDotProbing';
			return 'lfLiveDot';
		}

		function textOr(value, fallback) {
			return value === undefined || value === null ? String(fallback) : String(value);
		}

		/** 解析草稿里的数字：空串/非法值回落到 fallback，供预览安全降级。 */
		function numberOr(text, fallback) {
			const value = Number(text);
			return text === '' || Number.isFinite(value) ? (text === '' ? fallback : value) : fallback;
		}

		/**
		 * 一个 target 的重试计划（名义值 + 抖动区间）。
		 *
		 * 公式与 host 侧一致：先 `round(initial * multiplier^(n-1))`，再夹到
		 * maxDelayMs；抖动区间两端四舍五入，上端同样夹到 maxDelayMs。
		 *
		 * @param target - 草稿或配置里的 target（数字可以是字符串）。
		 * @returns `{ rows, totalMs, retries, truncated }`。
		 */
		function retryPlanRows(target) {
			const retries = Math.max(
				0,
				Math.floor(numberOr(target?.maxRetries, DEFAULTS.maxRetries)),
			);
			const initial = Math.max(1, numberOr(target?.initialDelayMs, DEFAULTS.initialDelayMs));
			const multiplier = Math.max(1.01, numberOr(target?.multiplier, DEFAULTS.multiplier));
			const maxDelay = Math.max(initial, numberOr(target?.maxDelayMs, DEFAULTS.maxDelayMs));
			const jitter = Math.min(1, Math.max(0, numberOr(target?.jitterRatio, DEFAULTS.jitterRatio)));

			const rows = [];
			let totalMs = 0;
			const shown = Math.min(retries, PREVIEW_LIMIT);
			for (let index = 0; index < shown; index += 1) {
				const nominalMs = Math.min(Math.round(initial * multiplier ** index), maxDelay);
				totalMs += nominalMs;
				rows.push({
					attempt: index + 1,
					nominalMs,
					lowMs: Math.round(nominalMs * (1 - jitter)),
					highMs: Math.min(Math.round(nominalMs * (1 + jitter)), maxDelay),
				});
			}
			return { rows, retries, totalMs, truncated: retries > shown };
		}

		/** 配置值 → 可编辑草稿（数字一律变成字符串，便于输入中间态）。 */
		function configDraft(value) {
			const resolved = value ?? {};
			const breaker = resolved.breaker ?? {};
			const probe = breaker.probe ?? {};
			const lockMs =
				Number.isFinite(Number(breaker.lockMs)) && Number(breaker.lockMs) > 0
					? Number(breaker.lockMs)
					: DEFAULTS.lockMs;
			return {
				enabled: resolved.enabled !== false,
				targets: (Array.isArray(resolved.targets) ? resolved.targets : []).map((target) => ({
					enabled: target?.enabled !== false,
					provider: target?.provider ?? '',
					model: target?.model ?? '',
					label: target?.label ?? '',
					maxRetries: textOr(target?.maxRetries, DEFAULTS.maxRetries),
					initialDelayMs: textOr(target?.initialDelayMs, DEFAULTS.initialDelayMs),
					multiplier: textOr(target?.multiplier, DEFAULTS.multiplier),
					maxDelayMs: textOr(target?.maxDelayMs, DEFAULTS.maxDelayMs),
					jitterRatio: textOr(target?.jitterRatio, DEFAULTS.jitterRatio),
				})),
				failureThreshold: textOr(breaker.failureThreshold, DEFAULTS.failureThreshold),
				lockMinutes: textOr(Math.round(lockMs / 6000) / 10, DEFAULTS.lockMs / 60000),
				probeEnabled: probe.enabled !== false,
				probeBackground: probe.background === true,
				probeTimeoutMs: textOr(probe.timeoutMs, DEFAULTS.probeTimeoutMs),
				probeMaxTokens: textOr(probe.maxTokens, DEFAULTS.probeMaxTokens),
				probePrompt: probe.prompt ?? DEFAULTS.probePrompt,
				maxTotalMs: textOr(resolved.limits?.maxTotalMs, DEFAULTS.maxTotalMs),
				maxAttempts: textOr(resolved.limits?.maxAttempts, DEFAULTS.maxAttempts),
				stateFile: breaker.stateFile ?? DEFAULTS.stateFile,
				retryMalformed: resolved.toolCalls?.retryMalformed !== false,
			};
		}

		/** 草稿 → 写回配置的 target；数值已通过校验，这里直接 Number()。 */
		function storedTarget(target) {
			return {
				enabled: target.enabled !== false,
				provider: target.provider.trim(),
				model: target.model.trim(),
				label: target.label.trim(),
				maxRetries: Number(target.maxRetries),
				initialDelayMs: Number(target.initialDelayMs),
				multiplier: Number(target.multiplier),
				maxDelayMs: Number(target.maxDelayMs),
				jitterRatio: Number(target.jitterRatio),
			};
		}

		function defaultTarget() {
			return {
				enabled: true,
				provider: '',
				model: '',
				label: '',
				maxRetries: String(DEFAULTS.maxRetries),
				initialDelayMs: String(DEFAULTS.initialDelayMs),
				multiplier: String(DEFAULTS.multiplier),
				maxDelayMs: String(DEFAULTS.maxDelayMs),
				jitterRatio: String(DEFAULTS.jitterRatio),
			};
		}

		/** 会话模型目录 → `Map<provider, Set<model>>`；目录没拿到时不返回索引。 */
		function catalogIndex(catalog) {
			const providers = new Map();
			for (const group of Array.isArray(catalog?.groups) ? catalog.groups : []) {
				if (typeof group?.id !== 'string' || group.id === '') continue;
				providers.set(
					group.id,
					new Set(
						(Array.isArray(group.models) ? group.models : [])
							.map((model) => model?.id)
							.filter((id) => typeof id === 'string' && id !== ''),
					),
				);
			}
			return providers;
		}

		/**
		 * 校验整张草稿。
		 *
		 * 只校验**启用**的 target 的 provider/model（禁用条目可以暂时留空，稍后再补）；
		 * 数值字段对所有条目都校验，因为写回时它们必须是合法数字。返回翻译键 + 参数，
		 * 由卡片按当前语言渲染。传入 `catalog` 时，provider/model 必须真实存在于会话
		 * 模型目录中，防止手填出无法使用的路由。
		 *
		 * @returns `[{ key, params }]`。
		 */
		function validateDraft(draft, route, catalog) {
			const errors = [];
			const seen = new Set();
			const known = catalog === undefined || catalog === null ? undefined : catalogIndex(catalog);
			draft.targets.forEach((target, index) => {
				const n = index + 1;
				const provider = target.provider.trim();
				const model = target.model.trim();
				if (target.enabled !== false) {
					if (provider === '') errors.push({ key: 'errProvider', params: { n } });
					if (model === '') errors.push({ key: 'errModel', params: { n } });
					if (provider === route) errors.push({ key: 'errSelf', params: { n } });
					if (known !== undefined && provider !== '' && provider !== route && !known.has(provider)) {
						errors.push({ key: 'errProviderUnknown', params: { n } });
					}
					if (
						known !== undefined &&
						provider !== '' &&
						provider !== route &&
						known.has(provider) &&
						model !== '' &&
						!known.get(provider).has(model)
					) {
						errors.push({ key: 'errModelUnknown', params: { n } });
					}
					const key = `${provider}\u0000${model}`;
					if (seen.has(key)) errors.push({ key: 'errDuplicate', params: { n } });
					seen.add(key);
				}

				const maxRetries = Number(target.maxRetries);
				if (target.maxRetries === '' || !Number.isSafeInteger(maxRetries) || maxRetries < 0) {
					errors.push({ key: 'errMaxRetries', params: { n } });
				}
				const initial = Number(target.initialDelayMs);
				if (target.initialDelayMs === '' || !Number.isFinite(initial) || initial <= 0) {
					errors.push({ key: 'errInitialDelay', params: { n } });
				}
				const multiplier = Number(target.multiplier);
				if (target.multiplier === '' || !Number.isFinite(multiplier) || multiplier <= 1) {
					errors.push({ key: 'errMultiplier', params: { n } });
				}
				const maxDelay = Number(target.maxDelayMs);
				if (target.maxDelayMs === '' || !Number.isFinite(maxDelay) || maxDelay < initial) {
					errors.push({ key: 'errMaxDelay', params: { n } });
				}
				const jitter = Number(target.jitterRatio);
				if (target.jitterRatio === '' || !Number.isFinite(jitter) || jitter < 0 || jitter > 1) {
					errors.push({ key: 'errJitter', params: { n } });
				}
			});

			const threshold = Number(draft.failureThreshold);
			if (draft.failureThreshold === '' || !Number.isSafeInteger(threshold) || threshold < 1) {
				errors.push({ key: 'errFailureThreshold' });
			}
			const lock = Number(draft.lockMinutes);
			if (draft.lockMinutes === '' || !Number.isFinite(lock) || lock <= 0) {
				errors.push({ key: 'errLock' });
			}
			const probeTimeout = Number(draft.probeTimeoutMs);
			if (draft.probeTimeoutMs === '' || !Number.isFinite(probeTimeout) || probeTimeout <= 0) {
				errors.push({ key: 'errProbeTimeout' });
			}
			const probeMaxTokens = Number(draft.probeMaxTokens);
			if (draft.probeMaxTokens === '' || !Number.isSafeInteger(probeMaxTokens) || probeMaxTokens < 1) {
				errors.push({ key: 'errProbeMaxTokens' });
			}
			if (draft.probePrompt.trim() === '') errors.push({ key: 'errProbePrompt' });
			const maxTotalMs = Number(draft.maxTotalMs);
			if (draft.maxTotalMs === '' || !Number.isFinite(maxTotalMs) || maxTotalMs < 0) {
				errors.push({ key: 'errMaxTotalMs' });
			}
			const maxAttempts = Number(draft.maxAttempts);
			if (draft.maxAttempts === '' || !Number.isSafeInteger(maxAttempts) || maxAttempts < 0) {
				errors.push({ key: 'errMaxAttempts' });
			}
			if (draft.stateFile.trim() === '') errors.push({ key: 'errStateFile' });

			return errors;
		}

		/** 草稿 → 一次写入的全部 ops（一个 revision、一次原子提交）。 */
		function buildOps(draft) {
			return [
				{ op: 'set', path: ['enabled'], value: draft.enabled },
				{ op: 'set', path: ['targets'], value: draft.targets.map(storedTarget) },
				{
					op: 'set',
					path: ['breaker'],
					value: {
						failureThreshold: Number(draft.failureThreshold),
						lockMs: Math.round(Number(draft.lockMinutes) * 60000),
						probe: {
							enabled: draft.probeEnabled,
							background: draft.probeBackground,
							timeoutMs: Number(draft.probeTimeoutMs),
							maxTokens: Number(draft.probeMaxTokens),
							prompt: draft.probePrompt,
						},
						stateFile: draft.stateFile.trim(),
					},
				},
				{
					op: 'set',
					path: ['limits'],
					value: {
						maxTotalMs: Number(draft.maxTotalMs),
						maxAttempts: Number(draft.maxAttempts),
					},
				},
				{
					op: 'set',
					path: ['toolCalls'],
					value: { retryMalformed: draft.retryMalformed },
				},
			];
		}

		function moveIn(entries, index, delta) {
			const next = [...entries];
			const [moved] = next.splice(index, 1);
			next.splice(index + delta, 0, moved);
			return next;
		}

		// ── 组件 ──────────────────────────────────────────────────────────────

		/** 一行一次重试；悬停/聚焦/点击展开。 */
		function PlanTip(props) {
			const { target, t } = props;
			const [open, setOpen] = react.useState(false);
			const [anchor, setAnchor] = react.useState(null);
			const plan = retryPlanRows(target);
			const range = plan.rows.length > 0 && Number(target.jitterRatio) > 0;
			const panelWidth = 260;

			/**
			 * 用视口坐标而不是父元素的 absolute 定位：设置弹窗会滚动、也会把
			 * 后一个 section 画在前面，absolute 面板会被裁掉或压在字下面。
			 * 下方空间不够时翻到按钮上方。
			 */
			const show = (element) => {
				if (element === null || typeof element === 'undefined' || typeof window === 'undefined') {
					setOpen(true);
					return;
				}
				const rect = element.getBoundingClientRect();
				const spaceBelow = window.innerHeight - rect.bottom - 12;
				const spaceAbove = rect.top - 12;
				const above = spaceBelow < 240 && spaceAbove > spaceBelow;
				setAnchor({
					left: Math.max(8, Math.min(rect.left, window.innerWidth - panelWidth - 8)),
					top: above ? undefined : rect.bottom + 6,
					bottom: above ? window.innerHeight - rect.top + 6 : undefined,
					maxHeight: Math.max(120, Math.min(340, above ? spaceAbove : spaceBelow)),
				});
				setOpen(true);
			};
			const hide = () => {
				setOpen(false);
				setAnchor(null);
			};

			return jsx.jsxs('span', {
				className: 'lfTipWrap',
				onMouseEnter: (event) => show(event.currentTarget),
				onMouseLeave: hide,
				onFocus: (event) => show(event.currentTarget),
				onBlur: (event) => {
					if (!event.currentTarget.contains(event.relatedTarget)) hide();
				},
				children: [
					jsx.jsx('button', {
						type: 'button',
						className: 'ccReset',
						'aria-expanded': open,
						onClick: (event) => (open ? hide() : show(event.currentTarget)),
						children: t('plan'),
					}),
					open
						? jsx.jsxs('div', {
								className: 'lfTipPanel',
								role: 'tooltip',
								style:
									anchor === null
										? undefined
										: {
												left: anchor.left,
												top: anchor.top,
												bottom: anchor.bottom,
												maxHeight: anchor.maxHeight,
											},
								children: [
									jsx.jsx('p', { className: 'lfTipTitle', children: t('planTitle') }),
									plan.rows.length === 0
										? jsx.jsx('p', { className: 'lfTipSub', children: t('planNone') })
										: jsx.jsxs('p', {
												className: 'lfTipSub',
												children: t('planSub', { n: plan.retries }),
											}),
									...plan.rows.map((row) =>
										jsx.jsxs(
											'div',
											{
												className: 'lfTipRow',
												children: [
													jsx.jsx('span', { children: t('planRow', { n: row.attempt }) }),
													jsx.jsx('span', {
														className: 'lfTipVal',
														children: range
															? t('planRange', {
																	low: formatMs(row.lowMs),
																	high: formatMs(row.highMs),
																})
															: formatMs(row.nominalMs),
													}),
												],
											},
											row.attempt,
										),
									),
									plan.truncated
										? jsx.jsx('p', {
												className: 'lfTipFoot',
												children: t('planTruncated', { n: plan.retries }),
											})
										: null,
									plan.rows.length === 0
										? null
										: plan.truncated
											? null
											: jsx.jsx('p', {
													className: 'lfTipFoot',
													children: [
														t('planTotal', { total: formatMs(plan.totalMs) }),
														range ? ` · ${t('planJitterNote')}` : '',
													].join(''),
												}),
								],
							})
						: null,
				],
			});
		}

		/** 一个数值字段：小标签 + 输入框。 */
		function Field(props) {
			const { label, value, invalid, disabled, wide, onChange } = props;
			return jsx.jsxs('label', {
				className: wide ? 'lfField lfFieldWide' : 'lfField',
				children: [
					jsx.jsx('span', { children: label }),
					jsx.jsx('input', {
						className: invalid ? 'ccInput ccInputInvalid' : 'ccInput',
						inputMode: 'decimal',
						value,
						disabled,
						'aria-label': label,
						onChange: (event) => onChange(event.target.value),
					}),
				],
			});
		}

		/** 一个 target 的编辑块。 */
		function TargetRow(props) {
			const {
				target,
				index,
				total,
				t,
				disabled,
				providerChoices,
				modelChoicesOf,
				choicesDisabled,
				onEdit,
				onMove,
				onRemove,
			} = props;
			const modelChoices = modelChoicesOf(target.provider);
			const knownModel = modelChoices.some((choice) => choice.id === target.model);
			const knownProvider = providerChoices.some((choice) => choice.id === target.provider);
			const plan = retryPlanRows(target);
			const summary = plan.rows.slice(0, 4).map((row) => formatMs(row.nominalMs)).join(' → ');
			const off = target.enabled === false;

			return jsx.jsxs('div', {
				className: off ? 'lfTarget lfTargetOff' : 'lfTarget',
				children: [
					jsx.jsxs('div', {
						className: 'lfTargetHead',
						children: [
							jsx.jsx('span', { className: 'ccChainIndex', children: String(index + 1) }),
							jsx.jsx('input', {
								type: 'checkbox',
								className: 'ccCheck',
								checked: !off,
								disabled,
								'aria-label': t('enableTarget'),
								onChange: (event) => onEdit({ enabled: event.target.checked }),
							}),
							jsx.jsx('input', {
								className: 'ccInput lfLabelInput',
								value: target.label,
								disabled,
								placeholder: t('labelPlaceholder'),
								'aria-label': t('labelPlaceholder'),
								onChange: (event) => onEdit({ label: event.target.value }),
							}),
							off ? jsx.jsx('span', { className: 'lfOffTag', children: t('disable') }) : null,
							jsx.jsx('button', {
								type: 'button',
								className: 'ccReset',
								disabled: disabled || index === 0,
								'aria-label': t('moveUp'),
								onClick: () => onMove(-1),
								children: '↑',
							}),
							jsx.jsx('button', {
								type: 'button',
								className: 'ccReset',
								disabled: disabled || index === total - 1,
								'aria-label': t('moveDown'),
								onClick: () => onMove(1),
								children: '↓',
							}),
							jsx.jsx('button', {
								type: 'button',
								className: 'ccReset',
								disabled,
								onClick: onRemove,
								children: t('remove'),
							}),
						],
					}),
					jsx.jsxs('div', {
						className: 'lfFields',
						children: [
							jsx.jsxs('label', {
								className: 'lfField lfFieldWide',
								children: [
									jsx.jsx('span', { children: t('provider') }),
									jsx.jsxs('select', {
										className:
											knownProvider || target.provider === ''
												? 'ccSelect lfSelect'
												: 'ccSelect lfSelect ccInputInvalid',
										value: target.provider,
										disabled: disabled || choicesDisabled,
										'aria-label': t('provider'),
										onChange: (event) => onEdit({ provider: event.target.value }),
										children: [
											target.provider === ''
												? jsx.jsx('option', {
														value: '',
														children: t('selectPlaceholder'),
													})
												: null,
											knownProvider || target.provider === ''
												? null
												: jsx.jsx('option', {
														value: target.provider,
														children: `${target.provider} ${t('notInCatalog')}`,
													}),
											...providerChoices.map((choice) =>
												jsx.jsx(
													'option',
													{ value: choice.id, children: choice.name },
													choice.id,
												),
											),
										],
									}),
								],
							}),
							jsx.jsxs('label', {
								className: 'lfField lfFieldWide',
								children: [
									jsx.jsx('span', { children: t('model') }),
									jsx.jsxs('select', {
										className:
											knownModel || target.model === ''
												? 'ccSelect lfSelect'
												: 'ccSelect lfSelect ccInputInvalid',
										value: target.model,
										disabled:
											disabled ||
											choicesDisabled ||
											target.provider === '' ||
											modelChoices.length === 0,
										'aria-label': t('model'),
										onChange: (event) => onEdit({ model: event.target.value }),
										children: [
											target.model === ''
												? jsx.jsx('option', {
														value: '',
														children: t('selectPlaceholder'),
													})
												: null,
											knownModel || target.model === ''
												? null
												: jsx.jsx('option', {
														value: target.model,
														children: `${target.model} ${t('notInCatalog')}`,
													}),
											...modelChoices.map((choice) =>
												jsx.jsx(
													'option',
													{ value: choice.id, children: choice.name },
													choice.id,
												),
											),
										],
									}),
								],
							}),
						],
					}),
					jsx.jsxs('div', {
						className: 'lfFields',
						children: [
							jsx.jsx(Field, {
								label: t('maxRetries'),
								value: target.maxRetries,
								disabled,
								invalid:
									target.maxRetries === '' ||
									!Number.isSafeInteger(Number(target.maxRetries)) ||
									Number(target.maxRetries) < 0,
								onChange: (value) => onEdit({ maxRetries: value }),
							}),
							jsx.jsx(Field, {
								label: t('initialDelay'),
								value: target.initialDelayMs,
								disabled,
								invalid: !(Number(target.initialDelayMs) > 0),
								onChange: (value) => onEdit({ initialDelayMs: value }),
							}),
							jsx.jsx(Field, {
								label: t('multiplier'),
								value: target.multiplier,
								disabled,
								invalid: !(Number(target.multiplier) > 1),
								onChange: (value) => onEdit({ multiplier: value }),
							}),
							jsx.jsx(Field, {
								label: t('maxDelay'),
								value: target.maxDelayMs,
								disabled,
								invalid: target.maxDelayMs === '' || !(Number(target.maxDelayMs) >= Number(target.initialDelayMs)),
								onChange: (value) => onEdit({ maxDelayMs: value }),
							}),
							jsx.jsx(Field, {
								label: t('jitter'),
								value: target.jitterRatio,
								disabled,
								invalid:
									target.jitterRatio === '' ||
									!(Number(target.jitterRatio) >= 0 && Number(target.jitterRatio) <= 1),
								onChange: (value) => onEdit({ jitterRatio: value }),
							}),
						],
					}),
					jsx.jsxs('div', {
						className: 'lfFoot',
						children: [
							jsx.jsx(PlanTip, { target, t }),
							jsx.jsx('span', {
								className: 'lfSummary',
								children:
									plan.rows.length === 0
										? t('planNone')
										: `${summary}${plan.rows.length > 4 ? ' → …' : ''}`,
							}),
						],
					}),
				],
			});
		}

		/**
		 * 轮询主机的 settings.describe，取本插件命名空间的 runtime 字段。
		 *
		 * 熔断状态写在 volatile 单元格里，不产生 settings/document-updated 事件，
		 * 所以不能等配置表单的推送，只能按固定间隔重新 describe。
		 */
		function useLiveState(readSettings) {
			const [state, setState] = react.useState({
				status: 'loading',
				runtime: undefined,
				error: null,
				fetchedAt: 0,
			});
			react.useEffect(() => {
				let alive = true;
				const read = async () => {
					try {
						const response = await readSettings();
						if (!alive) return;
						if (!response?.ok) {
							setState((current) => ({
								...current,
								status: 'error',
								error: response?.error?.message ?? 'settings.describe failed',
							}));
							return;
						}
						const row = (response.value?.namespaces ?? []).find((entry) => entry.ns === NS);
						setState({
							status: 'ready',
							runtime: row?.value?.runtime,
							error: null,
							fetchedAt: Date.now(),
						});
					} catch (failure) {
						if (!alive) return;
						setState((current) => ({
							...current,
							status: 'error',
							error: failure?.message ?? String(failure),
						}));
					}
				};
				void read();
				const timer = setInterval(() => void read(), 4000);
				return () => {
					alive = false;
					clearInterval(timer);
				};
			}, []);
			return state;
		}

		/** 熔断状态的只读视图：一行一个 target。 */
		function LiveState(props) {
			const { live, enabled, t } = props;
			const now = Date.now();
			const targets = Array.isArray(live.runtime?.targets) ? live.runtime.targets : [];
			return jsx.jsxs('div', {
				className: 'lfSection',
				children: [
					jsx.jsxs('div', {
						className: 'lfSectionHead',
						children: [
							jsx.jsx('span', { className: 'ccTitle', children: t('live') }),
							live.fetchedAt > 0
								? jsx.jsx('span', {
										className: 'lfCount',
										children: t('liveUpdated', { age: formatAge(now - live.fetchedAt) }),
									})
								: null,
						],
					}),
					jsx.jsx('p', { className: 'ccHint', children: t('liveHint') }),
					live.error === null
						? null
						: jsx.jsx('p', { className: 'ccError', children: t('liveError', { message: live.error }) }),
					!enabled
						? jsx.jsx('p', { className: 'ccSubHint', children: t('liveDisabled') })
						: targets.length === 0
							? jsx.jsx('p', { className: 'ccSubHint', children: t('liveEmpty') })
							: jsx.jsxs('div', {
									className: 'lfLiveRows',
									children: targets.map((row) => {
										const lockedFor = Number(row.lockedUntil) - now;
										return jsx.jsxs(
											'div',
											{
												className: 'lfLiveRow',
												children: [
													jsx.jsx('span', { className: liveDotClass(row.state) }),
													jsx.jsx('span', {
														className: 'lfLiveName',
														children: row.label || row.key,
													}),
													jsx.jsx('span', {
														className: 'lfLiveState',
														children: t(LIVE_STATE_KEYS[row.state] ?? 'liveStateUnknown'),
													}),
													jsx.jsx('span', {
														className: 'lfLiveDetail',
														children:
															lockedFor > 0
																? t('liveRemaining', { time: formatMs(lockedFor) })
																: '',
													}),
													jsx.jsx('span', {
														className: 'lfLiveCounts',
														children: [
															t('liveFailureCount', { n: row.failures ?? 0 }),
															' · ',
															t('liveLockCount', { n: row.locks ?? 0 }),
														].join(''),
													}),
												],
											},
											row.key ?? row.label,
										);
									}),
								}),
				],
			});
		}

		/** 插件详情页卡片。 */
		function FallbackCard(props) {
			const { t, useScope, useCatalog, reloadCatalog, useLive, mutate } = props;
			const snapshot = useScope((value) => value);
			const catalog = useCatalog();
			const catalogReady = catalog !== undefined && catalog !== null;
			const live = useLive();
			const [draft, setDraft] = react.useState(null);
			const [error, setError] = react.useState(null);
			const [saved, setSaved] = react.useState(false);

			if (snapshot?.status === 'loading' || snapshot?.status === undefined) {
				return jsx.jsxs('div', {
					className: 'ccWrap',
					children: [
						jsx.jsx('span', { className: 'ccTitle', children: t('title') }),
						jsx.jsx('p', { className: 'ccHint', children: t('loading') }),
					],
				});
			}
			if (snapshot.status === 'unavailable' || snapshot.mode === 'memory') {
				return jsx.jsxs('div', {
					className: 'ccWrap',
					children: [
						jsx.jsx('span', { className: 'ccTitle', children: t('title') }),
						jsx.jsx('p', { className: 'ccError', children: t('unavailable') }),
					],
				});
			}

			const value = snapshot.value;
			if (value === undefined) {
				return jsx.jsxs('div', {
					className: 'ccWrap',
					children: [
						jsx.jsx('span', { className: 'ccTitle', children: t('title') }),
						jsx.jsx('p', { className: 'ccError', children: t('unavailable') }),
					],
				});
			}

			const readOnly = snapshot.writable === false;
			const shown = draft ?? configDraft(value);
			const route = typeof value.route === 'string' && value.route !== '' ? value.route : DEFAULT_ROUTE;
			const errors = validateDraft(shown, route, catalogReady ? catalog : undefined);
			const dirty = draft !== null;

			const update = (patch) => {
				setSaved(false);
				setError(null);
				setDraft((current) => ({ ...(current ?? configDraft(value)), ...patch }));
			};
			const modelChoicesOf = (provider) => {
				const group = (catalog?.groups ?? []).find((entry) => entry.id === provider);
				return (group?.models ?? []).map((model) => ({
					id: model.id,
					name: model.name ?? model.id,
				}));
			};
			const editTarget = (index, patch) => {
				const base = draft ?? configDraft(value);
				update({
					targets: base.targets.map((target, position) => {
						if (position !== index) return target;
						const next = { ...target, ...patch };
						// provider 由目录下拉选择：换 provider 时把 model 收敛到新目录的第一项，
						// 不允许留下一个属于旧 provider 的 model id。
						if (patch.provider !== undefined && patch.provider !== target.provider) {
							next.model = modelChoicesOf(patch.provider)[0]?.id ?? '';
						}
						return next;
					}),
				});
			};
			const moveTarget = (index, delta) => {
				const base = draft ?? configDraft(value);
				update({ targets: moveIn(base.targets, index, delta) });
			};
			const removeTarget = (index) => {
				const base = draft ?? configDraft(value);
				update({ targets: base.targets.filter((_, position) => position !== index) });
			};
			const addTarget = () => {
				const base = draft ?? configDraft(value);
				update({ targets: [...base.targets, defaultTarget()] });
			};
			const discard = () => {
				setDraft(null);
				setError(null);
				setSaved(false);
			};
			const commit = async () => {
				if (errors.length > 0 || readOnly || !catalogReady) return;
				setError(null);
				setSaved(false);
				try {
					if (!(await mutate(buildOps(shown)))) throw new Error(t('writeRefused'));
					setDraft(null);
					setSaved(true);
				} catch (failure) {
					setError(failure?.message ?? String(failure));
				}
			};

			const providerChoices = (catalog?.groups ?? [])
				.filter((group) => group.id !== route)
				.map((group) => ({
					id: group.id,
					name: group.name ?? group.id,
				}));
			const enabledCount = shown.targets.filter((target) => target.enabled !== false).length;

			return jsx.jsxs('div', {
				className: 'ccWrap',
				children: [
					jsx.jsxs('div', {
						className: 'lfHead',
						children: [
							jsx.jsx('span', { className: 'ccTitle', children: t('title') }),
							jsx.jsxs('span', {
								className: 'lfRoute',
								children: ['route · ', route],
							}),
						],
					}),
					jsx.jsx('p', { className: 'ccHint', children: t('hint') }),
					readOnly ? jsx.jsx('p', { className: 'ccError', children: t('readOnly') }) : null,
					jsx.jsxs('div', {
						className: 'ccRow',
						children: [
							jsx.jsx('input', {
								type: 'checkbox',
								className: 'ccCheck',
								checked: shown.enabled,
								disabled: readOnly,
								'aria-label': t('enabled'),
								onChange: (event) => update({ enabled: event.target.checked }),
							}),
							jsx.jsx('span', { className: 'ccLabel', children: t('enabled') }),
						],
					}),
					jsx.jsxs('div', {
						className: 'ccRow',
						children: [
							jsx.jsx('span', { className: 'ccLabel', children: t('route') }),
							jsx.jsx('span', { className: 'lfRoute', children: route }),
						],
					}),
					jsx.jsx('p', { className: 'ccSubHint', children: t('routeHint') }),

					jsx.jsxs('div', {
						className: 'lfSection',
						children: [
							jsx.jsxs('div', {
								className: 'lfSectionHead',
								children: [
									jsx.jsx('span', { className: 'ccTitle', children: t('targets') }),
									jsx.jsx('span', {
										className: 'lfCount',
										children: t('targetCount', {
											total: shown.targets.length,
											enabled: enabledCount,
										}),
									}),
									jsx.jsx('button', {
										type: 'button',
										className: 'ccReset',
										disabled: readOnly,
										onClick: addTarget,
										children: `+ ${t('addTarget')}`,
									}),
								],
							}),
							shown.targets.length === 0
								? jsx.jsx('p', { className: 'ccSubHint', children: t('targetsEmpty') })
								: null,
							catalog === undefined
								? jsx.jsx('p', { className: 'ccSubHint', children: t('catalogLoading') })
								: null,
							catalog === null
								? jsx.jsxs('div', {
										className: 'ccRow',
										children: [
											jsx.jsx('p', { className: 'ccError', children: t('catalogFailed') }),
											jsx.jsx('button', {
												type: 'button',
												className: 'ccReset',
												onClick: reloadCatalog,
												children: t('catalogRetry'),
											}),
										],
									})
								: null,
							...shown.targets.map((target, index) =>
								jsx.jsx(
									TargetRow,
									{
										target,
										index,
										total: shown.targets.length,
										t,
										disabled: readOnly,
										choicesDisabled: !catalogReady,
										providerChoices,
										modelChoicesOf,
										onEdit: (patch) => editTarget(index, patch),
										onMove: (delta) => moveTarget(index, delta),
										onRemove: () => removeTarget(index),
									},
									index,
								),
							),
						],
					}),

					jsx.jsxs('div', {
						className: 'lfSection',
						children: [
							jsx.jsx('span', { className: 'ccTitle', children: t('limits') }),
							jsx.jsx('p', { className: 'ccHint', children: t('limitsHint') }),
							jsx.jsxs('div', {
								className: 'lfFields',
								children: [
									jsx.jsx(Field, {
										label: t('maxTotalMs'),
										value: shown.maxTotalMs,
										disabled: readOnly,
										invalid:
											shown.maxTotalMs === '' ||
											!Number.isFinite(Number(shown.maxTotalMs)) ||
											Number(shown.maxTotalMs) < 0,
										onChange: (value) => update({ maxTotalMs: value }),
									}),
									jsx.jsx(Field, {
										label: t('maxAttempts'),
										value: shown.maxAttempts,
										disabled: readOnly,
										invalid:
											shown.maxAttempts === '' ||
											!Number.isSafeInteger(Number(shown.maxAttempts)) ||
											Number(shown.maxAttempts) < 0,
										onChange: (value) => update({ maxAttempts: value }),
									}),
								],
							}),
						],
					}),

					jsx.jsxs('div', {
						className: 'lfSection',
						children: [
							jsx.jsx('span', { className: 'ccTitle', children: t('breaker') }),
							jsx.jsx('p', { className: 'ccHint', children: t('breakerHint') }),
							jsx.jsxs('div', {
								className: 'lfFields',
								children: [
									jsx.jsx(Field, {
										label: t('failureThreshold'),
										value: shown.failureThreshold,
										disabled: readOnly,
										invalid:
											!Number.isSafeInteger(Number(shown.failureThreshold)) ||
											Number(shown.failureThreshold) < 1,
										onChange: (value) => update({ failureThreshold: value }),
									}),
									jsx.jsx(Field, {
										label: t('lockMinutes'),
										value: shown.lockMinutes,
										disabled: readOnly,
										invalid: !(Number(shown.lockMinutes) > 0),
										onChange: (value) => update({ lockMinutes: value }),
									}),
								],
							}),
							jsx.jsxs('div', {
								className: 'ccRow',
								children: [
									jsx.jsx('input', {
										type: 'checkbox',
										className: 'ccCheck',
										checked: shown.probeEnabled,
										disabled: readOnly,
										'aria-label': t('probe'),
										onChange: (event) => update({ probeEnabled: event.target.checked }),
									}),
									jsx.jsx('span', { className: 'ccLabel', children: t('probe') }),
								],
							}),
							shown.probeEnabled
								? jsx.jsxs('div', {
										className: 'lfFields',
										children: [
											jsx.jsx(Field, {
												label: t('probeTimeout'),
												value: shown.probeTimeoutMs,
												disabled: readOnly,
												invalid: !(Number(shown.probeTimeoutMs) > 0),
												onChange: (value) => update({ probeTimeoutMs: value }),
											}),
											jsx.jsx(Field, {
												label: t('probeMaxTokens'),
												value: shown.probeMaxTokens,
												disabled: readOnly,
												invalid:
													!Number.isSafeInteger(Number(shown.probeMaxTokens)) ||
													Number(shown.probeMaxTokens) < 1,
												onChange: (value) => update({ probeMaxTokens: value }),
											}),
											jsx.jsx(Field, {
												label: t('probePrompt'),
												value: shown.probePrompt,
												disabled: readOnly,
												invalid: shown.probePrompt.trim() === '',
												wide: true,
												onChange: (value) => update({ probePrompt: value }),
											}),
										],
									})
								: null,
							shown.probeEnabled
								? jsx.jsxs('div', {
										className: 'ccRow',
										children: [
											jsx.jsx('input', {
												type: 'checkbox',
												className: 'ccCheck',
												checked: shown.probeBackground,
												disabled: readOnly,
												'aria-label': t('probeBackground'),
												onChange: (event) =>
													update({ probeBackground: event.target.checked }),
											}),
											jsx.jsx('span', {
												className: 'ccLabel',
												children: t('probeBackground'),
											}),
										],
									})
								: null,
							shown.probeEnabled
								? jsx.jsx('p', { className: 'ccSubHint', children: t('probeBackgroundHint') })
								: null,
							jsx.jsxs('label', {
								className: 'lfField lfFieldWide',
								children: [
									jsx.jsx('span', { children: t('stateFile') }),
									jsx.jsx('input', {
										className:
											shown.stateFile.trim() === ''
												? 'ccInput lfStateInput ccInputInvalid'
												: 'ccInput lfStateInput',
										value: shown.stateFile,
										disabled: readOnly,
										onChange: (event) => update({ stateFile: event.target.value }),
									}),
									jsx.jsx('span', { className: 'lfSummary', children: t('stateFileHint') }),
								],
							}),
						],
					}),

					jsx.jsxs('div', {
						className: 'lfSection',
						children: [
							jsx.jsx('span', { className: 'ccTitle', children: t('toolCalls') }),
							jsx.jsxs('div', {
								className: 'ccRow',
								children: [
									jsx.jsx('input', {
										type: 'checkbox',
										className: 'ccCheck',
										checked: shown.retryMalformed,
										disabled: readOnly,
										'aria-label': t('retryMalformed'),
										onChange: (event) => update({ retryMalformed: event.target.checked }),
									}),
									jsx.jsx('span', { className: 'ccLabel', children: t('retryMalformed') }),
								],
							}),
							jsx.jsx('p', { className: 'ccSubHint', children: t('retryMalformedHint') }),
						],
					}),

					jsx.jsx(LiveState, { live, enabled: shown.enabled, t }),

					errors.length > 0 && dirty
						? jsx.jsxs('div', {
								children: [
									jsx.jsx('p', { className: 'ccError', children: t('invalid') }),
									jsx.jsx('ul', {
										className: 'ccList',
										children: errors.slice(0, 8).map((entry, index) =>
											jsx.jsx(
												'li',
												{ children: t(entry.key, entry.params) },
												`${entry.key}-${index}`,
											),
										),
									}),
								],
							})
						: null,
					error === null ? null : jsx.jsx('p', { className: 'ccError', children: error }),
					dirty
						? jsx.jsxs('div', {
								className: 'lfActions',
								children: [
									jsx.jsx('button', {
										type: 'button',
										className: 'lfPrimary',
										disabled: readOnly || errors.length > 0 || !catalogReady,
										onClick: () => void commit(),
										children: t('save'),
									}),
									jsx.jsx('button', {
										type: 'button',
										className: 'ccReset',
										onClick: discard,
										children: t('discard'),
									}),
									jsx.jsx('span', {
										className: 'lfSummary',
										children: catalogReady ? t('unsaved') : t('catalogBlocked'),
									}),
								],
							})
						: saved
							? jsx.jsx('p', { className: 'lfSummary', children: t('saved') })
							: null,
				],
			});
		}

		/**
		 * 会话模型目录：懒加载；失败是事实而不是空选择器（可以用 reload 重试）。
		 *
		 * provider/model 只能从这里选，不再提供自由输入。
		 */
		function useCatalogService(ctx) {
			let state = { status: 'idle', value: undefined };
			const listeners = new Set();
			const notify = () => {
				for (const listener of listeners) listener();
			};
			const load = () => {
				if (state.status === 'loading') return;
				state = { status: 'loading', value: undefined };
				notify();
				Promise.resolve()
					.then(() => ctx.remote.session.modelCatalog())
					.then((response) => {
						if (!response?.ok) {
							throw new Error(
								response?.error === undefined
									? 'modelCatalog failed'
									: `${response.error.code}: ${response.error.message}`,
							);
						}
						state = { status: 'ready', value: response.value };
					})
					.catch(() => {
						state = { status: 'failed', value: null };
					})
					.finally(notify);
			};
			const useCatalog = () => {
				const [value, setValue] = react.useState(() => state.value);
				react.useEffect(() => {
					load();
					const listener = () => setValue(state.value);
					listeners.add(listener);
					listener();
					return () => {
						listeners.delete(listener);
					};
				}, []);
				return value;
			};
			return { useCatalog, reload: load };
		}

		/** 注册卡片。 */
		function apply(ctx) {
			const t = ctx.locale.bind(NS);
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'llm-resilience: card copy');

			// 设置平面按 profile entry id 索引表单，不是插件自己的命名空间。
			// 这个字面量必须与 cordis.patch.yml 的 `- id` 一致。
			const form = ctx.configForms.get('llm-fallback');
			const scope = {
				getSnapshot: () => form.getSnapshot(),
				subscribe: (listener) => form.subscribe(listener),
				mutate: (ops) => form.mutate(ops),
			};
			const catalogService = useCatalogService(ctx);

			// 放在「插件 → 已安装插件 → dsh-llm-resilience」详情页，而不是 Settings → Models：
			// `plugins.bundle.config` 是按**包名**索引的，与已安装列表里的行配对。
			// whileServed 会等宿主真正提供 `llm-fallback` 命名空间后再注册。
			ctx.effect(
				() =>
					ctx.configForms.whileServed([NS], () =>
						ctx.slots.inject('plugins.bundle.config', () =>
							ctx.slots.register(
								{
									name: 'plugins.bundle.config',
									key: PACKAGE_NAME,
									order: 30,
									locale: NS,
									inject: () => ({
										t,
										mutate: (ops) => scope.mutate(ops),
										useCatalog: catalogService.useCatalog,
										reloadCatalog: catalogService.reload,
										useLive: () => useLiveState(() => ctx.remote.settings.describe()),
										useScope: (select) => {
											const [snapshot, setSnapshot] = react.useState(() =>
												scope.getSnapshot(),
											);
											react.useEffect(
												() => scope.subscribe(() => setSnapshot(scope.getSnapshot())),
												[],
											);
											return select(snapshot);
										},
									}),
								},
								FallbackCard,
							),
						),
					),
				'llm-resilience: plugins page',
			);
		}

		/** 必需客户端服务；名字写错 = entry 永远 pending。 */
		const inject = ['locale', 'remote', 'remote.session', 'remote.settings', 'configForms', 'slots'];

		exports.apply = apply;
		exports.inject = inject;
		exports.__test = {
			DEFAULTS,
			buildOps,
			configDraft,
			defaultTarget,
			formatAge,
			formatMs,
			moveIn,
			retryPlanRows,
			storedTarget,
			validateDraft,
		};
		return module.exports;
	},
});
