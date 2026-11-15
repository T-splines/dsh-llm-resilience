/**
 * dsh-llm-resilience 的纯策略核心。
 *
 * 这里不碰 dsh runtime：退避曲线、错误分类、链校验和熔断状态机都是纯函数/纯类，
 * 可以在 `node --test` 里直接钉契约。适配器（Phase 1）只负责把这里的决策接到
 * `ctx.llm.stream()` 和底层 provider 上。
 *
 * @module dsh-llm-resilience/policy
 */

export const ACTIONS = Object.freeze({
	RETRY: 'retry',
	FALLBACK: 'fallback',
	FAIL: 'fail',
});

const ACTION_VALUES = new Set(Object.values(ACTIONS));

export const BREAKER_STATES = Object.freeze({
	CLOSED: 'closed',
	OPEN: 'open',
	HALF_OPEN: 'half-open',
	PROBING: 'probing',
});

/** 单 target 的默认重试参数；与 dsh 内置 retryPolicy 的默认口径一致。 */
export const DEFAULT_TARGET = Object.freeze({
	maxRetries: 5,
	initialDelayMs: 1500,
	multiplier: 2,
	maxDelayMs: 20000,
	jitterRatio: 0.3,
});

const CANCELLED_CODES = new Set(['ABORTED', 'CANCELLED', 'CANCELED', 'ABORT_ERR']);

/** 这些错误重试有意义：请求可能下次成功。 */
const RETRYABLE_CODES = new Set([
	'EMPTY_RESPONSE',
	'RATE_LIMIT',
	'SERVER',
	'TIMEOUT',
	'TRANSPORT',
	'STREAM_CLOSED',
	'MALFORMED_RESPONSE',
]);

/** 这些错误换一个 provider/model 更有意义，重试同一个 target 通常没用。 */
const FALLBACK_CODES = new Set([
	'AUTH',
	'INVALID_CREDENTIAL',
	'MISSING_CREDENTIAL',
	'QUOTA',
	'ACCOUNT_QUOTA',
	'NO_ADAPTER',
	'UNKNOWN_MODEL',
	'MODEL_NOT_FOUND',
]);

/**
 * dsh 的请求级恢复协议。宿主在 `agent/request-error` 上据此卸载图片 / 压缩上下文后重试；
 * 链路层必须原样抛出这两个 code（`IMAGE_OFFLOAD_REQUIRED` 还带 `offloadImages`），
 * 任何覆盖都会让恢复路径失效。
 */
const HOST_RECOVERY_CODES = new Set(['IMAGE_OFFLOAD_REQUIRED', 'CONTEXT_WINDOW_EXCEEDED']);

/** 这些错误是请求本身的问题，fallback 到别的 target 也不该假装能修。 */
const FAIL_CODES = new Set([
	'UNSUPPORTED_OPTION',
	'UNSUPPORTED_CONTENT',
	'INVALID_REQUEST',
	'INVALID_MODEL_INFO',
	...HOST_RECOVERY_CODES,
]);

/**
 * OpenDesign 这类网关把「会员权益/额度评估失败」放在 SERVER 500 里返回。
 * 它是确定性状态，不是瞬时抖动；必须直接 fallback，不能按普通 500 重试。
 */
const ENTITLEMENT_MESSAGE_RE = /membership|entitlement|quota|billing|balance|credit|plan\b/i;

function codeOf(failure) {
	return typeof failure?.code === 'string' && failure.code.trim() ? failure.code.trim() : 'UNKNOWN';
}

/**
 * 把一次模型请求失败分类成 retry / fallback / fail。
 *
 * @param failure - `{ code, message }` 形状的 LlmFailure。
 * @param overrides - 按 code 覆盖分类，值必须是 retry/fallback/fail。
 * @returns `{ action, code, reason }`。
 */
export function classifyFailure(failure, overrides = {}) {
	const code = codeOf(failure);
	const message = typeof failure?.message === 'string' ? failure.message : '';
	// 先于 codeActions：这两个 code 是宿主的恢复协议，不允许被覆盖。
	if (HOST_RECOVERY_CODES.has(code)) return { action: ACTIONS.FAIL, code, reason: 'host-recovery' };
	const override = overrides?.[code];
	if (ACTION_VALUES.has(override)) return { action: override, code, reason: 'override' };

	if (code === 'SERVER' && ENTITLEMENT_MESSAGE_RE.test(message)) {
		return { action: ACTIONS.FALLBACK, code, reason: 'entitlement' };
	}
	if (CANCELLED_CODES.has(code)) return { action: ACTIONS.FAIL, code, reason: 'cancelled' };
	if (FAIL_CODES.has(code)) return { action: ACTIONS.FAIL, code, reason: 'request-invalid' };
	if (FALLBACK_CODES.has(code)) return { action: ACTIONS.FALLBACK, code, reason: 'provider-state' };
	if (RETRYABLE_CODES.has(code)) return { action: ACTIONS.RETRY, code, reason: 'transient' };

	// 未知 code 默认走 fallback：最后一个 target 仍会把原始错误抛出来，不是静默吞掉。
	return { action: ACTIONS.FALLBACK, code, reason: 'unknown-code' };
}

/** 校验按 code 的覆盖表；拼错的值在 apply 时就要报出来，不能静默忽略。 */
export function validateCodeActions(codeActions = {}) {
	const errors = [];
	for (const [code, action] of Object.entries(codeActions ?? {})) {
		if (HOST_RECOVERY_CODES.has(code)) {
			errors.push(`codeActions.${code} cannot be overridden: the host owns this request-level recovery code`);
			continue;
		}
		if (!ACTION_VALUES.has(action)) {
			errors.push(`codeActions.${code} must be one of retry/fallback/fail (got ${JSON.stringify(action)})`);
		}
	}
	return errors;
}

/** 把 target 的缺省值补齐，并夹到合法范围；只用于纯计算，不做配置校验。 */
function normalizedTarget(target) {
	const initialDelayMs = positive(target?.initialDelayMs, DEFAULT_TARGET.initialDelayMs);
	const maxDelayMs = Math.max(positive(target?.maxDelayMs, DEFAULT_TARGET.maxDelayMs), initialDelayMs);
	return {
		maxRetries: Math.max(0, Math.floor(target?.maxRetries ?? DEFAULT_TARGET.maxRetries)),
		initialDelayMs,
		multiplier: Math.max(1.01, target?.multiplier ?? DEFAULT_TARGET.multiplier),
		maxDelayMs,
		jitterRatio: Math.min(1, Math.max(0, target?.jitterRatio ?? DEFAULT_TARGET.jitterRatio)),
	};
}

function positive(value, fallback) {
	return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * 第 `attempt` 次重试的名义等待时间（1-based，不含首次请求）。
 *
 * `attempt=1` 用 initialDelayMs；之后每次乘 multiplier；不超过 maxDelayMs。
 */
export function nominalDelayMs(target, attempt) {
	const t = normalizedTarget(target);
	const exponent = Math.max(0, Math.floor(attempt) - 1);
	return Math.min(Math.round(t.initialDelayMs * t.multiplier ** exponent), t.maxDelayMs);
}

/**
 * 给名义等待加对称抖动，并再次夹到 maxDelayMs。
 *
 * @param nominalDelayMs - 名义等待。
 * @param jitterRatio - 0..1；0 表示不抖动。
 * @param random - 返回 [0,1) 的随机源；测试可注入。
 * @param maxDelayMs - 上限。
 */
export function jitteredDelayMs(nominalDelayMs, jitterRatio, random = Math.random, maxDelayMs = Infinity) {
	const jitter = Math.min(1, Math.max(0, jitterRatio));
	const factor = 1 - jitter + 2 * jitter * random();
	return Math.min(Math.round(nominalDelayMs * factor), maxDelayMs);
}

/**
 * 生成一个 target 的完整重试计划。
 *
 * 每次重试的等待独立计算；不会把上一个 target 的退避带进来。
 *
 * @param target - 链上的 target 配置。
 * @param options.random - 随机源，测试可注入。
 * @returns `[{ attempt, nominalDelayMs, delayMs }]`。
 */
export function buildRetrySchedule(target, { random = Math.random } = {}) {
	const t = normalizedTarget(target);
	return Array.from({ length: t.maxRetries }, (_, index) => {
		const attempt = index + 1;
		const nominal = nominalDelayMs(t, attempt);
		return {
			attempt,
			nominalDelayMs: nominal,
			delayMs: jitteredDelayMs(nominal, t.jitterRatio, random, t.maxDelayMs),
		};
	});
}

/**
 * 不带抖动的名义计划，供设置页逐行显示。
 *
 * @param target - 链上的 target 配置。
 * @returns `[{ attempt, nominalDelayMs }]`。
 */
export function nominalSchedule(target) {
	const t = normalizedTarget(target);
	return Array.from({ length: t.maxRetries }, (_, index) => ({
		attempt: index + 1,
		nominalDelayMs: nominalDelayMs(t, index + 1),
	}));
}

/** 链上 target 的稳定身份；同一 provider 下的不同 model 是两个独立 target。 */
export function targetKey(target) {
	return `${target?.provider ?? ''}\u0000${target?.model ?? ''}`;
}

/**
 * 参与本次链的 target：`enabled: false` 的条目保留配置但不参与校验、路由和计数。
 *
 * @param targets - 配置里的完整链。
 * @returns 顺序不变的可参与条目。
 */
export function enabledTargets(targets) {
	return (Array.isArray(targets) ? targets : []).filter((target) => target?.enabled !== false);
}

/** 设置页/日志里的显示名。 */
export function targetLabel(target) {
	const label = typeof target?.label === 'string' ? target.label.trim() : '';
	return label || `${target?.provider ?? '?'}/${target?.model ?? '?'}`;
}

/**
 * 校验 fallback 链。
 *
 * 空 targets 是合法的 dormant 状态；非空时每个 target 必须完整、唯一、不能指向
 * wrapper 自己（否则会递归）。
 *
 * @param route - 合成 provider 的 route 名。
 * @param targets - 链上的 target 配置。
 * @returns 错误字符串数组；空数组表示通过。
 */
export function validateChain(route, targets) {
	const errors = [];
	if (typeof route !== 'string' || route.trim() === '') errors.push('route must be a non-empty string');
	const list = Array.isArray(targets) ? targets : [];
	const seen = new Set();
	for (const [index, target] of list.entries()) {
		// 保留原始下标：禁用条目被跳过，但报错里的 targets[i] 仍能对上配置文件。
		if (target?.enabled === false) continue;
		const at = `targets[${index}]`;
		if (target === null || typeof target !== 'object') {
			errors.push(`${at} must be an object`);
			continue;
		}
		if (typeof target.provider !== 'string' || target.provider.trim() === '') {
			errors.push(`${at}.provider must be a non-empty string`);
		}
		if (typeof target.model !== 'string' || target.model.trim() === '') {
			errors.push(`${at}.model must be a non-empty string`);
		}
		if (typeof route === 'string' && target.provider === route) {
			errors.push(`${at}.provider must not equal the wrapper route "${route}"`);
		}
		const key = targetKey(target);
		if (seen.has(key)) errors.push(`${at} duplicates ${targetLabel(target)}`);
		seen.add(key);

		const maxRetries = target.maxRetries ?? DEFAULT_TARGET.maxRetries;
		const initialDelayMs = target.initialDelayMs ?? DEFAULT_TARGET.initialDelayMs;
		const multiplier = target.multiplier ?? DEFAULT_TARGET.multiplier;
		const maxDelayMs = target.maxDelayMs ?? DEFAULT_TARGET.maxDelayMs;
		const jitterRatio = target.jitterRatio ?? DEFAULT_TARGET.jitterRatio;
		if (!Number.isSafeInteger(maxRetries) || maxRetries < 0) errors.push(`${at}.maxRetries must be a non-negative integer`);
		if (!Number.isFinite(initialDelayMs) || initialDelayMs <= 0) errors.push(`${at}.initialDelayMs must be > 0`);
		if (!Number.isFinite(multiplier) || multiplier <= 1) errors.push(`${at}.multiplier must be > 1`);
		if (!Number.isFinite(maxDelayMs) || maxDelayMs < initialDelayMs) errors.push(`${at}.maxDelayMs must be >= initialDelayMs`);
		if (!Number.isFinite(jitterRatio) || jitterRatio < 0 || jitterRatio > 1) errors.push(`${at}.jitterRatio must be between 0 and 1`);
	}
	return errors;
}

/**
 * 每个 target 的熔断状态。
 *
 * - `closed`：正常使用。
 * - `open`：连败达到阈值，锁到 `lockedUntil`；期间跳过。
 * - `half-open`：锁已到期，允许一次探活。
 * - `probing`：探活进行中；期间其他请求跳过，避免打爆刚恢复的 provider。
 */
export class CircuitBreaker {
	constructor({ failureThreshold = 5, lockMs = 3600000, now = Date.now } = {}) {
		this.failureThreshold = Math.max(1, Math.floor(failureThreshold));
		this.lockMs = Math.max(1, Math.floor(lockMs));
		this.now = now;
		this.entries = new Map();
		/** 成功清除锁的时间，供多进程合并时删除别人磁盘上的旧锁。 */
		this.tombstones = new Map();
	}

	#entry(key) {
		let entry = this.entries.get(key);
		if (entry === undefined) {
			entry = { failures: 0, openedAt: null, lockedUntil: null, probing: false, locks: 0, updatedAt: null };
			this.entries.set(key, entry);
		}
		return entry;
	}

	/** 当前状态；`open` 的 entry 在锁到期后自动变成 `half-open`。 */
	state(key, now = this.now()) {
		const entry = this.entries.get(key);
		if (entry === undefined || entry.lockedUntil === null) return BREAKER_STATES.CLOSED;
		if (entry.probing) return BREAKER_STATES.PROBING;
		if (now < entry.lockedUntil) return BREAKER_STATES.OPEN;
		return BREAKER_STATES.HALF_OPEN;
	}

	/** 记录一次失败；达到阈值就开锁。锁住期间再失败会延长当前锁。 */
	recordFailure(key, now = this.now()) {
		const entry = this.#entry(key);
		this.tombstones.delete(key);
		entry.failures += 1;
		// 每次失败都推进 updatedAt：未达阈值的连败也要能在多进程合并时胜出，
		// 否则成功之后重新累计的连败永远写不进状态文件（见 mergeBreakerSnapshots）。
		entry.updatedAt = now;
		if (entry.lockedUntil !== null) {
			entry.probing = false;
			entry.lockedUntil = now + this.lockMs;
			return;
		}
		if (entry.failures >= this.failureThreshold) {
			entry.openedAt = now;
			entry.lockedUntil = now + this.lockMs;
			entry.locks += 1;
		}
	}

	/** 一次成功彻底清零该 target 的连败与锁。 */
	recordSuccess(key) {
		this.entries.delete(key);
		this.tombstones.set(key, this.now());
	}

	/** `half-open` 时抢占唯一一次探活资格；其他状态返回 false。 */
	beginProbe(key, now = this.now()) {
		const entry = this.entries.get(key);
		if (entry === undefined || entry.lockedUntil === null || entry.probing || now < entry.lockedUntil) return false;
		entry.probing = true;
		return true;
	}

	probeSucceeded(key) {
		this.entries.delete(key);
		this.tombstones.set(key, this.now());
	}

	/**
	 * 放弃本次探活资格但不改变锁：请求在探活后被取消，或错误属于「请求本身
	 * 有问题」而不该记到 provider 头上时使用。锁保持原样，下个请求可以重新探。
	 */
	releaseProbe(key) {
		const entry = this.entries.get(key);
		if (entry?.probing === true) entry.probing = false;
	}

	/** 探活失败：重新锁一轮，并把连败记满。 */
	probeFailed(key, now = this.now()) {
		const entry = this.#entry(key);
		this.tombstones.delete(key);
		entry.probing = false;
		entry.failures = Math.max(entry.failures, this.failureThreshold);
		entry.lockedUntil = now + this.lockMs;
		entry.locks += 1;
		entry.updatedAt = now;
	}

	/** 可序列化快照，供持久化到 stateFile。 */
	snapshot() {
		const cutoff = this.now() - 24 * 3600 * 1000;
		for (const [key, at] of this.tombstones) {
			if (at < cutoff) this.tombstones.delete(key);
		}
		return {
			version: 1,
			entries: Object.fromEntries(this.entries),
			cleared: Object.fromEntries(this.tombstones),
		};
	}

	/** 从快照恢复；版本不认识就返回一个空 breaker，不让旧格式破坏启动。 */
	static fromSnapshot(snapshot, options = {}) {
		const breaker = new CircuitBreaker(options);
		if (snapshot?.version !== 1 || typeof snapshot.entries !== 'object' || snapshot.entries === null) return breaker;
		for (const [key, entry] of Object.entries(snapshot.entries)) {
			if (entry === null || typeof entry !== 'object') continue;
			breaker.entries.set(key, {
				failures: Number.isSafeInteger(entry.failures) && entry.failures >= 0 ? entry.failures : 0,
				openedAt: Number.isFinite(entry.openedAt) ? entry.openedAt : null,
				lockedUntil: Number.isFinite(entry.lockedUntil) ? entry.lockedUntil : null,
				probing: false,
				locks: Number.isSafeInteger(entry.locks) && entry.locks >= 0 ? entry.locks : 0,
				// 旧格式没有 updatedAt：退回 openedAt（开锁时间）作兼容，缺失时按 0。
				updatedAt: Number.isFinite(entry.updatedAt)
					? entry.updatedAt
					: Number.isFinite(entry.openedAt)
						? entry.openedAt
						: null,
			});
		}
		if (snapshot.cleared !== null && typeof snapshot.cleared === 'object') {
			for (const [key, at] of Object.entries(snapshot.cleared)) {
				if (Number.isFinite(at)) breaker.tombstones.set(key, at);
			}
		}
		return breaker;
	}
}

/**
 * 按链顺序给出每个 target 的当前状态。适配器只对 `closed` 直接用、对 `half-open`
 * 先 `beginProbe()`、对 `open`/`probing` 跳过。
 */
export function planAttempts(targets, breaker, now = Date.now()) {
	return (targets ?? []).map((target, index) => {
		const key = targetKey(target);
		return {
			target,
			index,
			key,
			label: targetLabel(target),
			state: breaker.state(key, now),
		};
	});
}

/** 过滤掉当前不可用的 target，保留顺序。 */
export function usableAttempts(attempts) {
	return attempts.filter(({ state }) => state !== BREAKER_STATES.OPEN && state !== BREAKER_STATES.PROBING);
}

/**
 * 一次用户请求的全局预算：跨 target、跨重试累计。
 *
 * 只记录“已经真正发出去”的次数；等待时间也算进 deadline。0 表示该维度不限制。
 */
export class AttemptBudget {
	constructor({ maxTotalMs = 0, maxAttempts = 0 } = {}, now = Date.now) {
		this.now = now;
		this.maxTotalMs = Math.max(0, Number(maxTotalMs) || 0);
		this.maxAttempts = Math.max(0, Math.floor(Number(maxAttempts) || 0));
		this.startedAt = now();
		this.deadlineAt = this.maxTotalMs > 0 ? this.startedAt + this.maxTotalMs : Infinity;
		this.attempts = 0;
	}

	remainingMs(now = this.now()) {
		if (this.deadlineAt === Infinity) return Infinity;
		return Math.max(0, this.deadlineAt - now);
	}

	/** @returns 'deadline' | 'attempts' | undefined */
	stopReason(now = this.now()) {
		if (this.deadlineAt !== Infinity && now >= this.deadlineAt) return 'deadline';
		if (this.maxAttempts > 0 && this.attempts >= this.maxAttempts) return 'attempts';
		return undefined;
	}

	/** 记一次真正发出的上游请求。 */
	take() {
		this.attempts += 1;
	}
}

/**
 * 当前熔断状态的序列化视图，供设置页显示。
 *
 * `lockedUntil` 用 0 表示没有锁，避免在 JSON 里出现 null 与 number 的联合。
 */
export function runtimeSnapshot(targets, breaker, now = Date.now()) {
	const entries = breaker?.snapshot?.().entries ?? {};
	return {
		version: 1,
		updatedAt: now,
		targets: (targets ?? []).map((target) => {
			const key = targetKey(target);
			const entry = entries[key];
			return {
				key,
				label: targetLabel(target),
				state: breaker?.state?.(key, now) ?? BREAKER_STATES.CLOSED,
				failures: Number.isSafeInteger(entry?.failures) ? entry.failures : 0,
				lockedUntil: Number.isFinite(entry?.lockedUntil) ? entry.lockedUntil : 0,
				locks: Number.isSafeInteger(entry?.locks) ? entry.locks : 0,
			};
		}),
	};
}

/**
 * 条目的「最后变化时间」：优先 `updatedAt`（每次失败都推进），旧格式退回 `openedAt`。
 * 用于和 tombstone 比先后；缺失一律按 0，让「没时间戳的旧条目」输给任何成功清除。
 */
function entryTime(entry) {
	if (Number.isFinite(entry?.updatedAt)) return entry.updatedAt;
	if (Number.isFinite(entry?.openedAt)) return entry.openedAt;
	return 0;
}

function snapshotRank(entry) {
	const lockedUntil = Number(entry?.lockedUntil) || 0;
	const failures = Number(entry?.failures) || 0;
	const locks = Number(entry?.locks) || 0;
	return [lockedUntil, failures, locks];
}

function rankGreater(left, right) {
	for (let index = 0; index < left.length; index += 1) {
		if (left[index] !== right[index]) return left[index] > right[index];
	}
	return false;
}

/**
 * 合并两份熔断快照，供多个 dsh 进程共享 stateFile。
 *
 * - 同一 key 取锁更晚、连败更多、锁次数更多的那份；
 * - `cleared`（成功清除锁的时间）会删除磁盘上更早的**任何**条目；
 * - 另一个进程在清除之后新建的条目保留，不会被旧成功误删；
 * - 本进程没有条目的 key 不会删除磁盘条目——宁可多探一次也不误放行。
 *
 * `updatedAt` 是这个比较的时间轴：**每次失败都推进**（连败未达阈值时 `openedAt` 是
 * null）。旧实现只拿 `openedAt` 比 tombstone，`null` 被当成 0，于是「成功之后重新累计
 * 的连败」永远输给 tombstone、写不进状态文件——重启后连败归零，阈值形同虚设。
 */
export function mergeBreakerSnapshots(base, incoming) {
	const entries = { ...(base?.entries ?? {}) };
	const cleared = { ...(base?.cleared ?? {}) };

	for (const [key, at] of Object.entries(incoming?.cleared ?? {})) {
		if (!Number.isFinite(at)) continue;
		const entry = entries[key];
		if (entry !== undefined && entryTime(entry) <= at) delete entries[key];
		cleared[key] = Math.max(cleared[key] ?? 0, at);
	}

	for (const [key, entry] of Object.entries(incoming?.entries ?? {})) {
		if (cleared[key] !== undefined && entryTime(entry) <= cleared[key]) continue;
		const current = entries[key];
		if (current === undefined || rankGreater(snapshotRank(entry), snapshotRank(current))) {
			entries[key] = entry;
		}
	}
	return { version: 1, entries, cleared };
}
