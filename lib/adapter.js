/**
 * dsh-llm-resilience 的 provider 适配器。
 *
 * 对外它是一条普通 provider route（默认 `fallback`）：宿主照常 resolve 模型、
 * 组装请求、消费 chunk。对内它按 `targets` 顺序逐条尝试上游 provider，每个
 * target 有独立的重试预算和退避曲线，失败后从下一个 target 的第一次重试重新
 * 起算，不继承上一条已经翻倍过的延迟。
 *
 * 三条硬约束：
 *
 * 1. **内容一旦交付就不能换 target**。文本/推理增量会立刻转发给宿主；只有
 *    tool-call 的 block-start/delta 会缓冲到该 block 的 `block-end`。因此：
 *    - 文本已交付后失败：抛错，交给宿主的整步重试（它能丢弃半截消息）；
 *    - 只有未完成的 tool-call 被缓冲：丢弃缓冲、安全重试（宿主什么都没看见）。
 * 2. **熔断按 provider+model 记账**。连续失败达到阈值后锁 `lockMs`；锁到期后
 *    先发一个极小的探活请求，探活成功才真正使用该 target，失败则再锁一轮。
 * 3. **外层重试只保留整步重放需要的 code**。链自身的预算由本适配器执行；
 *    只有「内容已交付后失败」才回落到 dsh-llm-retry 的整步重放，避免耗尽整条链
 *    之后又被外层重放一遍。
 *
 * @module dsh-llm-resilience/adapter
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

import { LlmAdapter, LlmError, resolveRetryPolicy } from '@deepseek-ai/dsh-llm';

import { resolvePluginConfig } from './config.js';
import {
	ACTIONS,
	AttemptBudget,
	BREAKER_STATES,
	CircuitBreaker,
	buildRetrySchedule,
	classifyFailure,
	enabledTargets,
	planAttempts,
	runtimeSnapshot,
	targetLabel,
	usableAttempts,
	validateChain,
} from './policy.js';
import { readStateFileSync, writeStateFileMerged } from './state-file.js';

const ENVELOPE_KIND = 'dsh-llm-resilience';
/** Replay envelopes written before the 0.5.0 rename remain readable. */
const LEGACY_ENVELOPE_KINDS = new Set(['dsh-llm-fallback']);
const ENVELOPE_VERSION = 1;
const AUTO_MODEL = 'auto';
/** cosmokit 的共享 volatile 写协议；设置页 describe 读取的就是这个活单元格。 */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write');
const RUNTIME_PUBLISH_MS = 5000;
const FLUSH_RETRY_MS = 1000;

/** 合成 route 自己的外层策略：只让「已交付内容后失败」走宿主的整步重放。 */
const OUTER_RETRY_POLICY = resolveRetryPolicy(
	{
		mode: 'normal',
		maxRetries: 3,
		// 不含 FALLBACK_EXHAUSTED / ALL_TARGETS_LOCKED / NO_TARGETS：
		// 链已经尝试完的错误再重放整条链只会放大延迟。
		retryableCodes: [
			'EMPTY_RESPONSE',
			'MALFORMED_RESPONSE',
			'PI_AI_ERROR',
			'RATE_LIMIT',
			'SERVER',
			'STREAM_CLOSED',
			'TIMEOUT',
			'TRANSPORT',
			'UNKNOWN',
		],
		backoff: { initialDelayMs: 500, maxDelayMs: 5000, jitterRatio: 0.2 },
	},
	'llm-fallback.retryPolicy',
);

function isAborted(signal) {
	return signal?.aborted === true;
}

/** 把任意抛出值收敛成 LlmFailure 形状；调用方被取消时统一成 ABORTED。 */
function normalizeThrown(error, signal) {
	if (isAborted(signal)) return { message: 'request aborted', code: 'ABORTED' };
	if (error !== null && typeof error === 'object') {
		const carried = error.failure;
		if (
			carried !== null &&
			typeof carried === 'object' &&
			typeof carried.message === 'string' &&
			carried.message.length > 0 &&
			typeof carried.code === 'string' &&
			carried.code.length > 0
		) {
			return carried;
		}
		if (typeof error.code === 'string' && error.code.length > 0) {
			return {
				message: typeof error.message === 'string' && error.message.length > 0 ? error.message : 'LLM adapter failed',
				code: error.code,
				...(Number.isInteger(error.status) && error.status >= 100 && error.status <= 599 ? { status: error.status } : {}),
				...(Number.isSafeInteger(error.offloadImages) && error.offloadImages > 0
					? { offloadImages: error.offloadImages }
					: {}),
			};
		}
	}
	const message = error instanceof Error && error.message ? error.message : String(error ?? 'LLM adapter failed');
	return { message, code: 'UNKNOWN' };
}

function failureError(failure, message) {
	return new LlmError(message ?? failure.message, failure.code || 'UNKNOWN', {
		...(Number.isInteger(failure.status) && failure.status >= 100 && failure.status <= 599
			? { status: failure.status }
			: {}),
		...(typeof failure.requestId === 'string' && failure.requestId.length > 0
			? { requestId: failure.requestId }
			: {}),
		...(Number.isFinite(failure.providerRetryAfterMs) && failure.providerRetryAfterMs > 0
			? { providerRetryAfterMs: failure.providerRetryAfterMs }
			: {}),
		// 宿主的 image-offload 恢复依赖这个字段；链路层只负责原样带出去。
		...(Number.isSafeInteger(failure.offloadImages) && failure.offloadImages > 0
			? { offloadImages: failure.offloadImages }
			: {}),
	});
}

function abortedFinish(signal) {
	const reason = signal?.reason;
	const message = reason instanceof Error && reason.message ? reason.message : 'request aborted';
	return {
		type: 'finish',
		reason: { kind: 'aborted', failure: { message, code: 'ABORTED' } },
	};
}

/** 可被调用方取消的等待；返回 false 表示被取消。 */
function sleep(ms, signal) {
	if (isAborted(signal)) return Promise.resolve(false);
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			cleanup();
			resolve(true);
		}, ms);
		function onAbort() {
			clearTimeout(timer);
			cleanup();
			resolve(false);
		}
		function cleanup() {
			signal?.removeEventListener?.('abort', onAbort);
		}
		signal?.addEventListener?.('abort', onAbort, { once: true });
	});
}

/** 合成 route 的 replay 信封：记住是哪个 target 产出的、内部信封原样保留。 */
function wrapFinish(finish, target) {
	const inner = finish.replayState;
	if (inner === undefined || inner.response === undefined) return finish;
	return {
		...finish,
		replayState: {
			response: {
				kind: ENVELOPE_KIND,
				version: ENVELOPE_VERSION,
				provider: target.provider,
				model: target.model,
				inner: inner.response,
			},
			...(inner.blocks === undefined ? {} : { blocks: inner.blocks }),
		},
	};
}

function isEnvelope(value) {
	return (
		value !== null &&
		typeof value === 'object' &&
		value.response !== null &&
		typeof value.response === 'object' &&
		(ENVELOPE_KIND === value.response.kind || LEGACY_ENVELOPE_KINDS.has(value.response.kind)) &&
		value.response.version === ENVELOPE_VERSION &&
		typeof value.response.provider === 'string' &&
		typeof value.response.model === 'string'
	);
}

/**
 * 把历史里由合成 route 产出的 assistant 消息还原成真实 target 的 replay 状态。
 *
 * 不还原的话，上游适配器看到的是 `provider: fallback` + 一个它不认识的
 * replay 信封；pi-ai 会降级成 provider-neutral 历史（能跑，但丢掉签名/id）。
 * 还原后与「不用 fallback 直接调该 target」的历史完全一致。
 */
function unwrapMessages(messages, route) {
	let changed = false;
	const mapped = messages.map((message) => {
		if (message.role !== 'assistant') return message;
		const source = message.source;
		if (source === null || typeof source !== 'object' || source.kind !== 'model' || source.provider !== route) {
			return message;
		}
		const envelope = source.replayState;
		if (!isEnvelope(envelope)) return message;
		changed = true;
		const { response } = envelope;
		return {
			...message,
			source: {
				kind: 'model',
				provider: response.provider,
				model: response.model,
				replayState: {
					response: response.inner,
					...(envelope.blocks === undefined ? {} : { blocks: envelope.blocks }),
				},
			},
		};
	});
	return changed ? mapped : messages;
}

/**
 * 一次 step 重放的请求指纹。
 *
 * 内容已交付后失败时，宿主会重放整个 step；请求的 messages 与失败时相同。
 * 用最后一条 user/tool 消息的 role + id 识别重放（system/developer 消息可能
 * 在重放时被重新注入，不能作为锚点）。没有 id 的手工请求退回用条数。
 */
function requestFingerprint(options) {
	const messages = options.messages ?? [];
	let pivot;
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.role === 'user' || message?.role === 'tool') {
			pivot = message;
			break;
		}
	}
	pivot ??= messages[messages.length - 1];
	const role = pivot?.role ?? '';
	const id = typeof pivot?.id === 'string' ? pivot.id : '';
	return id.length > 0 ? `${role}\u0000${id}` : `${role}\u0000${messages.length}`;
}

function labelsOf(targets) {
	return targets.map((target) => targetLabel(target)).join(' → ');
}

/** 展开 `$DSH_HOME`；dsh 默认 home 与 `dsh-home-paths` 的默认值一致。 */
function expandStateFile(value) {
	if (typeof value !== 'string' || value.length === 0) return undefined;
	const home =
		typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0
			? process.env.DSH_HOME
			: join(homedir(), '.dsh');
	return value.replace(/\$\{?DSH_HOME\}?/g, home);
}

function aggregateModelInfo(provider, model, entries, route) {
	const resolved = entries.filter((entry) => entry.info !== undefined).map((entry) => entry.info);
	const capabilities = {};

	if (resolved.length > 0) {
		const windows = resolved.map((info) => info.context?.contextWindow).filter((value) => Number.isFinite(value));
		if (windows.length > 0) capabilities.context = { contextWindow: Math.min(...windows) };

		const defaults = resolved.map((info) => info.defaultMaxTokens).filter((value) => Number.isSafeInteger(value));
		if (defaults.length > 0) capabilities.defaultMaxTokens = Math.min(...defaults);

		if (resolved.every((info) => Array.isArray(info.inputModalities))) {
			const common = resolved[0].inputModalities.filter((modality) =>
				resolved.every((info) => info.inputModalities.includes(modality)),
			);
			if (common.length > 0) capabilities.inputModalities = common;
		} else if (
			resolved.some((info) => Array.isArray(info.inputModalities) && !info.inputModalities.includes('image'))
		) {
			// 有 target 明确只收文本、其余 target 能力未知：按最保守的文本处理，
			// 免得把图片发给一个可能拒绝它的上游。
			capabilities.inputModalities = ['text'];
		}

		const reasoning = resolved.every((info) => info.reasoning !== undefined)
			? commonReasoning(resolved.map((info) => info.reasoning))
			: undefined;
		if (reasoning !== undefined) capabilities.reasoning = reasoning;

		const systemPromptUpdate = commonValue(resolved.map((info) => info.systemPromptUpdate));
		if (systemPromptUpdate !== undefined) capabilities.systemPromptUpdate = systemPromptUpdate;

		const toolUpdate = commonValue(resolved.map((info) => info.toolUpdate));
		if (toolUpdate !== undefined) capabilities.toolUpdate = toolUpdate;
	}

	const all = entries.map((entry) => entry.target);
	return {
		provider,
		id: model,
		name: all.length > 0 ? `Fallback chain (${all.length})` : 'Fallback chain',
		description: all.length > 0 ? `${route}: ${labelsOf(all)}` : `${route}: no targets configured`,
		...capabilities,
	};
}

/** 所有 target 都声明了同样的值时才算数；否则返回 undefined。 */
function commonValue(values) {
	if (values.length === 0) return undefined;
	const [first] = values;
	if (first === undefined) return undefined;
	return values.every((value) => value === first) ? first : undefined;
}

function commonReasoning(infos) {
	const [first] = infos;
	if (first === undefined || first.efforts.length === 0) return undefined;
	const common = first.efforts.filter((effort) =>
		infos.every((info) => info.efforts.some((candidate) => candidate.id === effort.id)),
	);
	if (common.length === 0) return undefined;
	const defaults = infos.map((info) => info.defaultEffort);
	const defaultEffort =
		defaults.every((value) => value !== undefined && value === defaults[0]) &&
		common.some((effort) => effort.id === defaults[0])
			? defaults[0]
			: undefined;
	return { efforts: common, ...(defaultEffort === undefined ? {} : { defaultEffort }) };
}

/** 把缓冲的 tool-call chunk 按 block 索引暂存，`block-end` 到达时才交付。 */
function bufferChunk(buffers, chunk) {
	const current = buffers.get(chunk.index);
	if (current === undefined) buffers.set(chunk.index, [chunk]);
	else current.push(chunk);
}

export class FallbackAdapter extends LlmAdapter {
	/**
	 * @param options.route - 注册到宿主上的合成 route（apply 时固定，改 route 需重启）。
	 * @param options.config - 组合层原始配置；每次调用重新解析，以获得设置页的实时值。
	 * @param options.llm - 宿主 llm 服务，用于 resolveModelInfo 和嵌套 stream。
	 * @param options.logger - cordis logger。
	 * @param options.now - 时钟，测试可注入。
	 * @param options.random - 抖动随机源，测试可注入。
	 * @param options.sleep - 等待实现，测试可注入。
	 * @param options.runtimeRef - 配置里的 `runtime` 活单元格；宿主用它把运行状态推给设置页。
	 * @param options.recordSession - `(sessionId, event) => void`；写会话日志，失败自吞。
	 */
	constructor({
		route,
		config,
		llm,
		logger,
		now = Date.now,
		random = Math.random,
		sleep: sleepFn = sleep,
		runtimeRef,
		recordSession = () => {},
	}) {
		super();
		this.route = route;
		this.configSource = config;
		this.llm = llm;
		this.logger = logger;
		this.now = now;
		this.random = random;
		this.sleep = sleepFn;
		this.runtimeRef = runtimeRef;
		this.recordSession = recordSession;
		this.breaker = undefined;
		this.stateFile = undefined;
		this.persistTimer = undefined;
		this.flushRetryTimer = undefined;
		this.flushChain = Promise.resolve();
		this.runtimeTimer = undefined;
		this.backgroundProbes = new Map();
		this.probeControllers = new Set();
		this.disposed = false;
		this.hints = new Map();
	}

	resolveConfig() {
		return resolvePluginConfig(this.configSource);
	}

	providerInfo(provider) {
		return { id: provider, name: 'Fallback chain' };
	}

	providerRetryPolicy() {
		return OUTER_RETRY_POLICY;
	}

	ensureBreaker(breakerConfig) {
		const failureThreshold = breakerConfig.failureThreshold;
		const lockMs = breakerConfig.lockMs;
		const stateFile = expandStateFile(breakerConfig.stateFile);
		if (
			this.breaker === undefined ||
			this.breaker.failureThreshold !== failureThreshold ||
			this.breaker.lockMs !== lockMs ||
			stateFile !== this.stateFile
		) {
			const snapshot =
				stateFile !== this.stateFile
					? readStateFileSync(stateFile, this.logger)
					: this.breaker?.snapshot();
			this.stateFile = stateFile;
			this.breaker = CircuitBreaker.fromSnapshot(snapshot, {
				failureThreshold,
				lockMs,
				now: this.now,
			});
		}
		this.#ensureRuntimeTimer();
		this.#publishRuntime();
		return this.breaker;
	}

	#ensureRuntimeTimer() {
		if (this.runtimeTimer !== undefined || this.runtimeRef === undefined || this.disposed) return;
		this.runtimeTimer = setInterval(() => this.#publishRuntime(), RUNTIME_PUBLISH_MS);
		this.runtimeTimer.unref?.();
	}

	/** 把当前熔断状态写进配置的 volatile 单元格；设置页 describe 会读到它。 */
	#publishRuntime() {
		const ref = this.runtimeRef;
		if (ref === null || typeof ref !== 'object' || typeof ref[VOLATILE_WRITE] !== 'function') return;
		if (this.breaker === undefined) return;
		const config = this.resolveConfig();
		try {
			ref[VOLATILE_WRITE](runtimeSnapshot(enabledTargets(config.targets), this.breaker, this.now()));
		} catch (error) {
			this.logger?.warn?.(
				`llm-resilience: cannot publish runtime state: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
	}

	/** 合并短时间内的多次熔断变化，避免每次失败都同步落盘。 */
	persist() {
		this.#publishRuntime();
		if (
			this.stateFile === undefined ||
			this.breaker === undefined ||
			this.persistTimer !== undefined ||
			this.disposed
		) {
			return;
		}
		this.persistTimer = setTimeout(() => {
			this.persistTimer = undefined;
			void this.flushState();
		}, 200);
		this.persistTimer.unref?.();
	}

	/**
	 * 持锁读-合并-写；拿不到锁时 1s 后重试。
	 *
	 * @returns 本次写入链的 promise，测试与 dispose 可以等待。
	 */
	flushState() {
		if (this.stateFile === undefined || this.breaker === undefined) return Promise.resolve();
		const path = this.stateFile;
		this.flushChain = this.flushChain
			.then(async () => {
				const merged = await writeStateFileMerged(path, this.breaker.snapshot(), {
					logger: this.logger,
					now: this.now,
				});
				if (merged === undefined) this.#scheduleFlushRetry();
			})
			.catch((error) => {
				this.logger?.warn?.(
					`llm-resilience: cannot persist breaker state ${path}: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
				this.#scheduleFlushRetry();
			});
		return this.flushChain;
	}

	#scheduleFlushRetry() {
		if (this.disposed || this.flushRetryTimer !== undefined) return;
		this.flushRetryTimer = setTimeout(() => {
			this.flushRetryTimer = undefined;
			void this.flushState();
		}, FLUSH_RETRY_MS);
		this.flushRetryTimer.unref?.();
	}

	dispose() {
		if (this.persistTimer !== undefined) {
			clearTimeout(this.persistTimer);
			this.persistTimer = undefined;
		}
		if (this.flushRetryTimer !== undefined) {
			clearTimeout(this.flushRetryTimer);
			this.flushRetryTimer = undefined;
		}
		if (this.runtimeTimer !== undefined) {
			clearInterval(this.runtimeTimer);
			this.runtimeTimer = undefined;
		}
		for (const controller of this.probeControllers) {
			controller.abort(new Error('llm-fallback disposed'));
		}
		this.probeControllers.clear();
		const finalFlush = this.flushState();
		this.disposed = true;
		return finalFlush;
	}

	async listModels(provider) {
		const config = this.resolveConfig();
		const targets = enabledTargets(config.targets);
		if (!config.enabled || targets.length === 0) return [];
		return [
			{
				provider,
				id: AUTO_MODEL,
				name: 'Fallback chain',
				description: labelsOf(targets),
			},
		];
	}

	async resolveModel(provider, model, signal) {
		const config = this.resolveConfig();
		if (!config.enabled) throw new LlmError('llm-resilience: plugin is disabled', 'DISABLED');
		const errors = validateChain(this.route, config.targets);
		if (errors.length > 0) {
			throw new LlmError(`llm-resilience: invalid configuration: ${errors.join('; ')}`, 'INVALID_CONFIG');
		}
		const targets = enabledTargets(config.targets);
		if (targets.length === 0) {
			throw new LlmError('llm-resilience: no targets configured', 'NO_TARGETS');
		}

		const entries = await Promise.all(
			targets.map(async (target) => {
				try {
					const info = await this.llm.resolveModelInfo(target.provider, target.model, signal);
					return { target, info };
				} catch (error) {
					if (isAborted(signal)) throw error;
					this.logger?.warn?.(
						`llm-resilience: cannot resolve target ${targetLabel(target)}: ${
							error instanceof Error ? error.message : String(error)
						}`,
					);
					return { target, info: undefined };
				}
			}),
		);

		return aggregateModelInfo(provider, model, entries, this.route);
	}

	async #runProbe(target, probe, signal) {
		if (isAborted(signal)) return { aborted: true };
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(new Error('probe timeout')), probe.timeoutMs);
		const fusedSignal = signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal]);
		let finish;
		let failure;
		try {
			const stream = this.llm.stream({
				provider: target.provider,
				model: target.model,
				messages: [{ role: 'user', content: [{ type: 'text', text: probe.prompt }] }],
				maxTokens: probe.maxTokens,
				signal: fusedSignal,
			});
			for await (const chunk of stream) {
				if (chunk.type === 'finish') {
					finish = chunk.reason;
					break;
				}
			}
		} catch (error) {
			failure = normalizeThrown(error, signal);
		} finally {
			clearTimeout(timer);
		}

		if (isAborted(signal)) return { aborted: true };
		if (failure !== undefined) return { ok: false, failure };
		if (finish === undefined) {
			return { ok: false, failure: { message: 'probe stream ended without a finish chunk', code: 'STREAM_CLOSED' } };
		}
		if (finish.kind === 'error' || finish.kind === 'aborted') {
			return { ok: false, failure: finish.failure };
		}
		return { ok: true };
	}

	/**
	 * 后台探活：当前请求跳过这个 target，结果写回熔断器供下次请求使用。
	 * 同一 target 同时只跑一个探活；dispose 时 abort 未完成的探活。
	 */
	#startBackgroundProbe({ target, key, label }, probe, options) {
		if (this.backgroundProbes.has(key) || this.disposed) return;
		const controller = new AbortController();
		this.probeControllers.add(controller);
		this.recordSession(options.sessionId, {
			kind: 'probe',
			target: label,
			phase: 'start',
			code: null,
			lockedUntil: 0,
		});
		const task = (async () => {
			const result = await this.#runProbe(target, probe, controller.signal);
			if (this.disposed || result.aborted === true) return;
			if (result.ok === true) {
				this.breaker.probeSucceeded(key);
				this.logger?.warn?.(`llm-resilience: background probe for ${label} succeeded; target is usable again`);
				this.recordSession(options.sessionId, {
					kind: 'probe',
					target: label,
					phase: 'success',
					code: null,
					lockedUntil: 0,
				});
			} else {
				this.breaker.probeFailed(key);
				const lockedUntil = this.breaker.snapshot().entries[key]?.lockedUntil ?? 0;
				const code = result.failure?.code ?? 'UNKNOWN';
				this.logger?.warn?.(
					`llm-resilience: background probe for ${label} failed (${code}); target locked again`,
				);
				this.recordSession(options.sessionId, {
					kind: 'probe',
					target: label,
					phase: 'failed',
					code,
					lockedUntil,
				});
			}
			this.persist();
		})()
			.catch((error) => {
				if (this.disposed) return;
				this.breaker.probeFailed(key);
				this.logger?.warn?.(
					`llm-resilience: background probe for ${label} crashed: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
				this.persist();
			})
			.finally(() => {
				this.backgroundProbes.delete(key);
				this.probeControllers.delete(controller);
			});
		this.backgroundProbes.set(key, task);
	}

	/**
	 * 单个 target 的一次完整尝试（含它自己的重试预算）。
	 *
	 * @returns `{kind:'success'}` / `{kind:'failed', failure}` /
	 *   `{kind:'fatal', failure}`（内容已交付，禁止换 target）/
	 *   `{kind:'stop', failure}`（请求本身有问题，换 target 也没意义）/
	 *   `{kind:'budget', reason, failure}`（全局时间/次数预算耗尽）/ `{kind:'aborted'}`。
	 */
	async *attemptTarget({ target, key, label, options, messages, config, breaker, budget }) {
		const schedule = buildRetrySchedule(target, { random: this.random });
		let lastFailure;

		for (let index = 0; index <= schedule.length; index += 1) {
			const stop = budget.stopReason();
			if (stop !== undefined) return { kind: 'budget', reason: stop, failure: lastFailure };

			if (index > 0) {
				const remaining = budget.remainingMs();
				if (remaining <= 0) return { kind: 'budget', reason: 'deadline', failure: lastFailure };
				const delayMs = Math.min(schedule[index - 1].delayMs, remaining);
				const waited = await this.sleep(delayMs, options.signal);
				if (!waited || isAborted(options.signal)) return { kind: 'aborted' };
				const afterSleep = budget.stopReason();
				if (afterSleep !== undefined) {
					return { kind: 'budget', reason: afterSleep, failure: lastFailure };
				}
			}

			budget.take();
			const result = yield* this.attemptOnce({ target, options, messages });
			if (result.kind === 'success') {
				breaker.recordSuccess(key);
				this.persist();
				return result;
			}
			if (result.kind === 'aborted') return result;

			lastFailure = result.failure;
			const classification = classifyFailure(lastFailure, config.codeActions);
			const action =
				classification.action === ACTIONS.RETRY &&
				lastFailure.code === 'MALFORMED_RESPONSE' &&
				config.toolCalls.retryMalformed === false &&
				classification.reason !== 'override'
					? ACTIONS.FALLBACK
					: classification.action;

			// 请求本身有问题：不记熔断、不换 target，直接把原始错误抛给宿主。
			// `reason` 带出分类依据，供会话记录与设置页区分「请求真的坏了」和
			// 「网关包装的上游故障被误判」（后者已改为 fallback，见 policy.js）。
			if (action === ACTIONS.FAIL) {
				return { kind: 'stop', failure: lastFailure, reason: classification.reason };
			}

			breaker.recordFailure(key);
			this.persist();

			// 内容已经交付：适配器层再试会重复内容；抛给宿主的整步重放。
			if (result.delivered) return { kind: 'fatal', failure: lastFailure };

			if (breaker.state(key) === BREAKER_STATES.OPEN) {
				this.logger?.warn?.(`llm-resilience: ${label} opened the circuit breaker`);
				this.recordSession(options.sessionId, {
					kind: 'lock',
					target: label,
					code: lastFailure.code,
					state: BREAKER_STATES.OPEN,
					lockedUntil: breaker.snapshot().entries[key]?.lockedUntil ?? 0,
				});
				return { kind: 'failed', failure: lastFailure };
			}
			if (action !== ACTIONS.RETRY || index >= schedule.length) {
				return { kind: 'failed', failure: lastFailure };
			}

			const nextDelayMs = Math.min(schedule[index].delayMs, budget.remainingMs());
			this.recordSession(options.sessionId, {
				kind: 'retry',
				target: label,
				code: lastFailure.code,
				attempt: index + 1,
				delayMs: Number.isFinite(nextDelayMs) ? nextDelayMs : schedule[index].delayMs,
			});
			this.logger?.warn?.(
				`llm-resilience: ${label} attempt ${index + 1}/${schedule.length + 1} failed (${lastFailure.code}); retrying in ${nextDelayMs}ms`,
			);
		}

		return { kind: 'failed', failure: lastFailure };
	}

	/**
	 * 单次上游调用。tool-call 的 block-start/delta 压到 `block-end` 再交付，
	 * 这样 MALFORMED_RESPONSE（工具参数非法、没有 block-end）发生时宿主还没
	 * 看见任何内容，可以安全重试。
	 */
	async *attemptOnce({ target, options, messages }) {
		const innerOptions = {
			...options,
			provider: target.provider,
			model: target.model,
			messages,
		};

		const toolBuffers = new Map();
		let usage;
		let finish;
		let failure;
		let delivered = false;

		try {
			for await (const chunk of this.llm.stream(innerOptions)) {
				if (chunk.type === 'usage') {
					usage = chunk;
					continue;
				}
				if (chunk.type === 'finish') {
					finish = chunk;
					break;
				}
				if (chunk.type === 'block-start' && chunk.blockType === 'tool-call') {
					bufferChunk(toolBuffers, chunk);
					continue;
				}
				if (chunk.type === 'tool-call-delta') {
					bufferChunk(toolBuffers, chunk);
					continue;
				}
				if (chunk.type === 'block-end' && chunk.block.type === 'tool-call' && toolBuffers.has(chunk.index)) {
					for (const buffered of toolBuffers.get(chunk.index)) yield buffered;
					toolBuffers.delete(chunk.index);
					yield chunk;
					delivered = true;
					continue;
				}
				yield chunk;
				delivered = true;
			}
		} catch (error) {
			failure = normalizeThrown(error, options.signal);
		}

		if (failure === undefined && finish?.reason.kind === 'error') failure = finish.reason.failure;
		if (failure === undefined && finish?.reason.kind === 'aborted') {
			failure = finish.reason.failure ?? { message: 'stream aborted', code: 'ABORTED' };
		}
		if (failure === undefined && finish === undefined) {
			failure = { message: 'inner stream ended without a finish chunk', code: 'STREAM_CLOSED' };
		}

		if (failure !== undefined) {
			if (isAborted(options.signal)) return { kind: 'aborted', usage };
			return { kind: 'failed', failure, delivered, usage };
		}

		if (toolBuffers.size > 0) {
			this.logger?.warn?.(
				`llm-resilience: ${targetLabel(target)} ended with ${toolBuffers.size} unterminated tool-call block(s); dropping them`,
			);
		}
		if (usage !== undefined) yield usage;
		yield wrapFinish(finish, target);
		return { kind: 'success' };
	}

	#rememberHint(options, key, failure) {
		if (options.sessionId === undefined) return;
		this.hints.set(options.sessionId, {
			fingerprint: requestFingerprint(options),
			key,
			failure,
		});
	}

	/** 取出并消费一次「上一步已经试到这个 target」的提示；指纹不同视为过期。 */
	#consumeHint(options) {
		if (options.sessionId === undefined) return undefined;
		const hint = this.hints.get(options.sessionId);
		if (hint === undefined) return undefined;
		this.hints.delete(options.sessionId);
		return hint.fingerprint === requestFingerprint(options) ? hint : undefined;
	}

	#lockedError(attempts, breaker) {
		const snapshot = breaker.snapshot().entries;
		const now = this.now();
		const details = attempts.map((attempt) => {
			const entry = snapshot[attempt.key];
			const until =
				entry !== undefined && Number.isFinite(entry.lockedUntil) && entry.lockedUntil > now
					? ` until ${new Date(entry.lockedUntil).toISOString()}`
					: '';
			return `${attempt.label} (${attempt.state}${until})`;
		});
		return new LlmError(`llm-resilience: all targets are locked: ${details.join(', ')}`, 'ALL_TARGETS_LOCKED');
	}

	#exhaustedError(lastFailure, attempted, attempts) {
		const last = lastFailure === undefined ? 'no target produced a response' : lastFailure.message;
		const locked = attempts.length - attempted;
		const suffix = locked > 0 ? `; ${locked} target(s) skipped by the circuit breaker` : '';
		return failureError(
			{
				...(lastFailure ?? { code: 'FALLBACK_EXHAUSTED' }),
				code: 'FALLBACK_EXHAUSTED',
			},
			`llm-resilience: ${attempted} target(s) failed; last: ${last}${suffix}`,
		);
	}

	#budgetError(reason, lastFailure, budget) {
		const elapsed = Math.max(0, this.now() - budget.startedAt);
		const code = reason === 'deadline' ? 'DEADLINE_EXCEEDED' : 'ATTEMPT_LIMIT';
		const label =
			reason === 'deadline'
				? `global deadline ${budget.maxTotalMs}ms`
				: `global attempt limit ${budget.maxAttempts}`;
		const last =
			lastFailure === undefined
				? 'no target produced a response'
				: `${lastFailure.code}: ${lastFailure.message}`;
		return failureError(
			{ ...(lastFailure ?? { message: last }), code },
			`llm-resilience: ${label} reached after ${budget.attempts} request(s) in ${elapsed}ms; last: ${last}`,
		);
	}

	async *stream(options) {
		const config = this.resolveConfig();
		if (!config.enabled) throw new LlmError('llm-resilience: plugin is disabled', 'DISABLED');

		const errors = validateChain(this.route, config.targets);
		if (errors.length > 0) {
			throw new LlmError(`llm-resilience: invalid configuration: ${errors.join('; ')}`, 'INVALID_CONFIG');
		}
		const targets = enabledTargets(config.targets);
		if (targets.length === 0) {
			throw new LlmError('llm-resilience: no targets configured', 'NO_TARGETS');
		}

		const breaker = this.ensureBreaker(config.breaker);
		const budget = new AttemptBudget(config.limits, this.now);
		const failBudget = (reason, failure) => {
			this.recordSession(options.sessionId, {
				kind: 'deadline',
				reason,
				attempts: budget.attempts,
				code: failure?.code ?? null,
				elapsedMs: Math.max(0, this.now() - budget.startedAt),
			});
			throw this.#budgetError(reason, failure, budget);
		};
		let attempts = planAttempts(targets, breaker, this.now());
		const hint = this.#consumeHint(options);
		if (hint !== undefined) {
			const start = attempts.findIndex((attempt) => attempt.key === hint.key);
			// 重放的续点是「轮转」，不是「截断」：
			//   从失败 target 的下一个开始（保证跨重放的进展，不会把 3 次重放预算
			//   全烧在一个粘性失败的链头上），绕回到被跳过的 target 结束。
			// 截断（旧实现 slice(start + 1)）会让 hint 之前的 target 在整次重放里
			// 彻底消失。线上实测（2026-11-11 21:41，会话 54e71f76）：eco 交付后断流
			// → hint=eco → 重放只剩 [flash] → flash 撞上网关瞬时的 entitlement 500
			// → 链空 → FALLBACK_EXHAUSTED「1 target(s) failed」，而 eco 早已恢复。
			// 链尾的 hint 轮转后就是「从它自己开始」，与原地重试等价（见 DESIGN §13.8）。
			if (start >= 0) {
				const next = start + 1;
				attempts = [...attempts.slice(next), ...attempts.slice(0, next)];
			}
		}
		// 不变量：targets 非空（上面已判 NO_TARGETS），hint 只改变顺序、不删除任何 target，
		// 因此这里一定还有可试的 target。真为空说明轮转逻辑写错——报错而不是伪装成链尾耗尽。
		if (attempts.length === 0) {
			throw new LlmError('llm-resilience: internal error: empty attempt plan for a non-empty chain', 'NO_TARGETS');
		}
		const usable = usableAttempts(attempts);
		if (usable.length === 0) throw this.#lockedError(attempts, breaker);

		const messages = unwrapMessages(options.messages, this.route);
		let lastFailure;
		let attempted = 0;

		for (const plan of usable) {
			if (isAborted(options.signal)) {
				yield abortedFinish(options.signal);
				return;
			}

			const stop = budget.stopReason();
			if (stop !== undefined) failBudget(stop, lastFailure);

			let claimedProbe = false;
			if (plan.state === BREAKER_STATES.HALF_OPEN) {
				// 后台探活：不阻塞当前请求，本次跳过；结果由下一个请求使用。
				if (config.breaker.probe.enabled && config.breaker.probe.background) {
					this.#startBackgroundProbe(plan, config.breaker.probe, options);
					continue;
				}
				if (!breaker.beginProbe(plan.key)) continue;
				claimedProbe = true;
				if (config.breaker.probe.enabled) {
					const remaining = budget.remainingMs();
					if (remaining <= 0) failBudget('deadline', lastFailure);
					const probeConfig =
						remaining === Infinity
							? config.breaker.probe
							: {
									...config.breaker.probe,
									timeoutMs: Math.max(1, Math.min(config.breaker.probe.timeoutMs, remaining)),
								};
					const probe = await this.#runProbe(plan.target, probeConfig, options.signal);
					if (probe.aborted === true) {
						breaker.releaseProbe(plan.key);
						yield abortedFinish(options.signal);
						return;
					}
					if (probe.ok !== true) {
						breaker.probeFailed(plan.key);
						this.persist();
						claimedProbe = false;
						lastFailure = probe.failure;
						this.logger?.warn?.(
							`llm-resilience: probe failed for ${plan.label} (${
								probe.failure?.code ?? 'UNKNOWN'
							}); target locked again`,
						);
						continue;
					}
					// 探活成功后保持 probing 状态，直到真实请求给出成功/失败。
				}
			}

			attempted += 1;
			let result;
			try {
				result = yield* this.attemptTarget({
					target: plan.target,
					key: plan.key,
					label: plan.label,
					options,
					messages,
					config,
					breaker,
					budget,
				});
			} finally {
				// 成功时 entry 已被 recordSuccess 删除；失败时 probing 已清；
				// 取消 / 请求本身有错时这里负责把探活资格还回去，避免永久卡住。
				if (claimedProbe) breaker.releaseProbe(plan.key);
			}

			if (result.kind === 'success') {
				this.hints.delete(options.sessionId);
				return;
			}
			if (result.kind === 'aborted') {
				this.hints.delete(options.sessionId);
				yield abortedFinish(options.signal);
				return;
			}
			if (result.kind === 'fatal') {
				this.#rememberHint(options, plan.key, result.failure);
				throw failureError(
					result.failure,
					`llm-resilience: ${plan.label} failed after streaming began; not switching targets: ${result.failure.message}`,
				);
			}
			if (result.kind === 'stop') {
				this.hints.delete(options.sessionId);
				// 可观测性：链在这里主动停下（不换 target），必须留一条可追的会话记录。
				// 宿主不设 console exporter（ctx.logger 不进日志文件），会话记录是唯一
				// 落盘的通道 —— 否则「为什么没走 fallback」只能靠猜。
				this.recordSession(options.sessionId, {
					kind: 'stop',
					target: plan.label,
					code: result.failure.code,
					reason: result.reason,
				});
				throw failureError(result.failure);
			}
			if (result.kind === 'budget') {
				failBudget(result.reason, result.failure ?? lastFailure);
			}

			lastFailure = result.failure;
			this.recordSession(options.sessionId, {
				kind: 'fallback',
				target: plan.label,
				code: result.failure.code,
			});
			this.logger?.warn?.(
				`llm-resilience: target ${plan.label} exhausted (${result.failure.code}); trying the next target`,
			);
		}

		this.hints.delete(options.sessionId);
		throw this.#exhaustedError(lastFailure, attempted, attempts);
	}
}
