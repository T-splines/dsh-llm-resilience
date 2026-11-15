/**
 * dsh-llm-resilience — 宿主平面入口。
 *
 * 注册一条合成 provider route（默认 `fallback`）。该 route 对内按 `targets`
 * 顺序逐条尝试真实 provider：每个 target 独立重试预算、独立熔断锁、锁到期先
 * 探活。`targets: []` 时保持 dormant：route 存在但不提供模型，也不接收请求。
 *
 * 非法配置（重复 target、自指 route、非法数值/覆盖值）在加载期直接失败；运行时
 * 错误（全部 target 失败、全部被锁）抛给宿主，不静默吞掉。
 *
 * @module dsh-llm-resilience
 */

import { FallbackAdapter } from './adapter.js';
import { Config, resolvePluginConfig } from './config.js';
import { validateChain, validateCodeActions, enabledTargets } from './policy.js';
import { createSessionRecorder } from './session-log.js';

export { Config };
export { FallbackAdapter } from './adapter.js';
export { plainConfig, resolvePluginConfig } from './config.js';
export {
	ACTIONS,
	AttemptBudget,
	BREAKER_STATES,
	CircuitBreaker,
	classifyFailure,
	buildRetrySchedule,
	enabledTargets,
	mergeBreakerSnapshots,
	nominalDelayMs,
	nominalSchedule,
	planAttempts,
	runtimeSnapshot,
	targetKey,
	targetLabel,
	usableAttempts,
	validateChain,
	validateCodeActions,
} from './policy.js';

/** 设置页用这个 loader entry id 取配置；与 cordis.patch.yml 的 `- id` 一致。 */
export const SETTINGS_ENTRY = 'llm-fallback';

/** 宿主 llm 服务是注册 adapter 的前提。 */
export const inject = ['llm'];

/**
 * 注册合成 route。配置非法时在加载期直接失败；链为空时保持 dormant。
 *
 * @param ctx - cordis 插件上下文。
 * @param config - 组合层配置（可能含 volatile 活单元格，适配器每次请求重新解析）。
 */
export function apply(ctx, config = {}) {
	const resolved = resolvePluginConfig(config);
	const errors = [...validateChain(resolved.route, resolved.targets), ...validateCodeActions(resolved.codeActions)];
	if (errors.length > 0) {
		throw new Error(`llm-resilience: invalid configuration: ${errors.join('; ')}`);
	}

	// `sessions` 不是本插件的 inject 依赖：直接读 ctx.sessions 会抛错并拆掉 fiber。
	// 用 ctx.get 拿可选服务，没有它时 session 记录器自动退化为空操作。
	const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined;
	const adapter = new FallbackAdapter({
		route: resolved.route,
		config,
		llm: ctx.llm,
		logger: ctx.logger,
		runtimeRef: config?.runtime,
		recordSession: createSessionRecorder(sessions, ctx.logger),
	});
	ctx.llm.registerAdapter([resolved.route], adapter);
	ctx.effect?.(() => () => adapter.dispose(), 'llm-resilience: flush breaker state');

	if (!resolved.enabled) {
		ctx.logger?.info?.(`llm-resilience: route "${resolved.route}" registered but plugin is disabled`);
		return;
	}
	const targets = enabledTargets(resolved.targets);
	if (targets.length === 0) {
		ctx.logger?.info?.(`llm-resilience: route "${resolved.route}" dormant (no enabled targets configured)`);
		return;
	}
	ctx.logger?.info?.(
		`llm-resilience: route "${resolved.route}" registered with ${targets.length} enabled target(s)`,
	);
}
