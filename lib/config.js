/**
 * dsh-llm-resilience 的配置 schema 与默认值。
 *
 * 0.2.0 的设置平面按 profile entry id 索引，且只把**根字段带 `.volatile()`** 的
 * entry 供出给设置页。这里的每个根字段都标了 volatile；读配置前必须先用
 * `plainConfig()` 解开活单元格，否则会按对象合并。
 *
 * @module dsh-llm-resilience/config
 */

import { isVolatile } from '@deepseek-ai/cosmokit';
import z from '@deepseek-ai/schemastery';

export const DEFAULT_ROUTE = 'fallback';
export const DEFAULT_STATE_FILE = '$DSH_HOME/storages/llm-resilience/state.json';

/**
 * 链上一个上游 target 的配置。
 *
 * `maxRetries` 是**首次请求之后**的重试次数；每个 target 有独立的预算和退避，
 * fallback 到下一个 target 时从头开始，不继承上一个 target 已经翻倍过的延迟。
 */
const targetSchema = z.object({
	enabled: z.boolean().default(true).description('关掉后这一条仍然保留配置，但不参与链'),
	provider: z.string().description('上游 provider route，例如 opendesign'),
	model: z.string().description('上游模型 id，例如 deepseek-v4.1-flash-eco'),
	label: z.string().default('').description('设置页显示名；留空则用 provider/model'),
	maxRetries: z.number().step(1).min(0).default(5).description('首次请求之后最多重试几次'),
	initialDelayMs: z.number().min(1).default(1500).description('第一次重试前的等待毫秒数'),
	multiplier: z.number().min(1.01).default(2).description('每次重试等待时间的倍率'),
	maxDelayMs: z.number().min(1).default(20000).description('单次等待的上限毫秒数'),
	jitterRatio: z.number().min(0).max(1).default(0.3).description('等待时间的对称抖动比例'),
});

const probeSchema = z
	.object({
		enabled: z.boolean().default(true),
		background: z
			.boolean()
			.default(false)
			.description('锁到期后在后台探活：当前请求跳过该 target，下次请求使用探活结果'),
		timeoutMs: z.number().min(1).default(10000),
		// 探活必须留够 token：推理模型会把预算全花在思考上，`maxTokens: 1`
		// 返回空内容，pi-ai 判 EMPTY_RESPONSE —— 探针于是永远判 target 不健康。
		// 实测（stream）：1/16 → finish=length 且无内容；64 → finish=stop 有内容；
		// 非流式下 flash 要到 256 才出内容。取 256 留足余量，代价是每个 target
		// 每小时最多一次几百 token 的请求。
		maxTokens: z.number().step(1).min(1).default(256),
		prompt: z.string().default('ping'),
	})
	.default({ enabled: true, background: false, timeoutMs: 10000, maxTokens: 256, prompt: 'ping' });

const breakerSchema = z
	.object({
		failureThreshold: z.number().step(1).min(1).default(5),
		lockMs: z.number().min(1).default(3600000),
		probe: probeSchema,
		stateFile: z.string().default(DEFAULT_STATE_FILE),
	})
	.default({
		failureThreshold: 5,
		lockMs: 3600000,
		probe: { enabled: true, background: false, timeoutMs: 10000, maxTokens: 256, prompt: 'ping' },
		stateFile: DEFAULT_STATE_FILE,
	});

/**
 * 一次用户请求的全局预算，跨所有 target 和重试累计。
 *
 * `maxTotalMs: 0` / `maxAttempts: 0` 表示不限制该项；默认 10 分钟、50 次尝试，
 * 防止 3 个 target × 10 次重试把一步拖成十几分钟。
 */
const limitsSchema = z
	.object({
		maxTotalMs: z.number().min(0).default(600000).description('整条链的总等待上限；0 表示不限制'),
		maxAttempts: z.number().step(1).min(0).default(50).description('整条链最多发起几次上游请求；0 表示不限制'),
	})
	.default({ maxTotalMs: 600000, maxAttempts: 50 });

/**
 * 宿主写入的运行状态，供设置页轮询显示。
 *
 * 这个字段不在插件自己的请求路径上读取；适配器通过共享的 volatile 写协议更新它，
 * settings/describe 读取活单元格时就能看到最新值。写回配置时不要包含它。
 */
const runtimeSchema = z
	.object({
		version: z.number().default(0),
		updatedAt: z.number().default(0),
		targets: z
			.array(
				z.object({
					key: z.string(),
					label: z.string(),
					state: z.string(),
					failures: z.number(),
					lockedUntil: z.number(),
					locks: z.number(),
				}),
			)
			.default([]),
	})
	.default({ version: 0, updatedAt: 0, targets: [] });

const toolCallsSchema = z
	.object({
		retryMalformed: z.boolean().default(true),
	})
	.default({ retryMalformed: true });

export const Config = z.object({
	enabled: z.boolean().default(true).volatile(),
	route: z.string().default(DEFAULT_ROUTE).volatile(),
	targets: z.array(targetSchema).default([]).volatile(),
	breaker: breakerSchema.volatile(),
	limits: limitsSchema.volatile(),
	toolCalls: toolCallsSchema.volatile(),
	codeActions: z.dict(z.string()).default({}).volatile(),
	runtime: runtimeSchema.description('宿主写入的运行状态；设置页只读').volatile(),
});

/** 解开 volatile 字段解析出来的活单元格（递归）。 */
export function plainConfig(value) {
	if (isVolatile(value)) return plainConfig(value.get());
	if (Array.isArray(value)) return value.map(plainConfig);
	if (value !== null && typeof value === 'object') {
		return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, plainConfig(child)]));
	}
	return value;
}

/**
 * 把组合层的原始 config 套上完整默认值。
 *
 * @param raw - 组合层传入的 config（可能含 volatile 活单元格）。
 * @returns 解析后的普通对象。
 */
export function resolvePluginConfig(raw) {
	return plainConfig(Config(plainConfig(raw) ?? {}));
}
