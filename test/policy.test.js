import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	ACTIONS,
	AttemptBudget,
	BREAKER_STATES,
	CircuitBreaker,
	buildRetrySchedule,
	classifyFailure,
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
} from '../lib/policy.js';

test('名义退避：2 倍倍率、20s 封顶', () => {
	const target = { initialDelayMs: 1500, multiplier: 2, maxDelayMs: 20000, maxRetries: 6 };
	const delays = nominalSchedule(target).map(({ nominalDelayMs }) => nominalDelayMs);
	assert.deepEqual(delays, [1500, 3000, 6000, 12000, 20000, 20000]);
});

test('名义退避：1.5 倍倍率按四舍五入', () => {
	const target = { initialDelayMs: 1500, multiplier: 1.5, maxDelayMs: 20000, maxRetries: 6 };
	const delays = nominalSchedule(target).map(({ nominalDelayMs }) => nominalDelayMs);
	assert.deepEqual(delays, [1500, 2250, 3375, 5063, 7594, 11391]);
});

test('抖动：random=0.5 时等于名义值，0/1 分别落在 ±jitter 边界并封顶', () => {
	const target = { initialDelayMs: 1500, multiplier: 2, maxDelayMs: 20000, maxRetries: 3, jitterRatio: 0.3 };
	assert.deepEqual(
		buildRetrySchedule(target, { random: () => 0.5 }).map(({ delayMs }) => delayMs),
		[1500, 3000, 6000],
	);
	assert.deepEqual(
		buildRetrySchedule(target, { random: () => 0 }).map(({ delayMs }) => delayMs),
		[1050, 2100, 4200],
	);
	assert.deepEqual(
		buildRetrySchedule(target, { random: () => 1 }).map(({ delayMs }) => delayMs),
		[1950, 3900, 7800],
	);
});

test('抖动后的值仍然不超过 maxDelayMs', () => {
	const target = { initialDelayMs: 15000, multiplier: 2, maxDelayMs: 20000, maxRetries: 2, jitterRatio: 0.3 };
	assert.deepEqual(
		buildRetrySchedule(target, { random: () => 1 }).map(({ delayMs }) => delayMs),
		[19500, 20000],
	);
});

test('每个 target 的退避从自己的 initialDelayMs 重新开始', () => {
	const first = { initialDelayMs: 1500, multiplier: 2, maxDelayMs: 20000, maxRetries: 3 };
	const second = { initialDelayMs: 500, multiplier: 2, maxDelayMs: 20000, maxRetries: 3 };
	assert.equal(nominalDelayMs(first, 3), 6000);
	assert.equal(nominalDelayMs(second, 1), 500);
});

test('错误分类：entitlement 500 直接 fallback，不当普通 500 重试', () => {
	const failure = {
		code: 'SERVER',
		message: '500: {"code":"internal_error","message":"[code=internal_error] failed to evaluate membership entitlement"}',
	};
	assert.deepEqual(classifyFailure(failure), {
		action: ACTIONS.FALLBACK,
		code: 'SERVER',
		reason: 'entitlement',
	});
});

test('错误分类：普通 500 / 超时 / 传输 / malformed 重试', () => {
	for (const code of ['SERVER', 'TIMEOUT', 'TRANSPORT', 'MALFORMED_RESPONSE', 'RATE_LIMIT', 'EMPTY_RESPONSE']) {
		assert.equal(classifyFailure({ code, message: 'transient' }).action, ACTIONS.RETRY, code);
	}
});

test('错误分类：认证 / 额度 / 模型不存在 fallback；取消和请求本身无效 fail', () => {
	for (const code of ['AUTH', 'INVALID_CREDENTIAL', 'MISSING_CREDENTIAL', 'QUOTA', 'ACCOUNT_QUOTA', 'UNKNOWN_MODEL']) {
		assert.equal(classifyFailure({ code }).action, ACTIONS.FALLBACK, code);
	}
	for (const code of [
		'ABORTED',
		'CANCELLED',
		'UNSUPPORTED_OPTION',
		'INVALID_REQUEST',
		// 宿主在 agent/request-error 上会卸载图片 / 压缩上下文后重试，
		// 链路层必须原样抛出，不能换成 FALLBACK_EXHAUSTED。
		'IMAGE_OFFLOAD_REQUIRED',
		'CONTEXT_WINDOW_EXCEEDED',
	]) {
		assert.equal(classifyFailure({ code }).action, ACTIONS.FAIL, code);
	}
});

test('错误分类：未知 code 默认 fallback，但可以被 codeActions 覆盖', () => {
	assert.equal(classifyFailure({ code: 'WEIRD' }).action, ACTIONS.FALLBACK);
	assert.deepEqual(classifyFailure({ code: 'WEIRD' }, { WEIRD: 'fail' }), {
		action: ACTIONS.FAIL,
		code: 'WEIRD',
		reason: 'override',
	});
	assert.deepEqual(
		classifyFailure(
			{ code: 'SERVER', message: 'failed to evaluate membership entitlement' },
			{ SERVER: 'retry' },
		),
		{ action: ACTIONS.RETRY, code: 'SERVER', reason: 'override' },
	);
});

test('宿主恢复 code 不允许被 codeActions 覆盖', () => {
	for (const code of ['IMAGE_OFFLOAD_REQUIRED', 'CONTEXT_WINDOW_EXCEEDED']) {
		assert.deepEqual(classifyFailure({ code }, { [code]: 'fallback' }), {
			action: ACTIONS.FAIL,
			code,
			reason: 'host-recovery',
		});
		const errors = validateCodeActions({ [code]: 'fallback' });
		assert.equal(errors.length, 1);
		assert.match(errors[0], /cannot be overridden/);
	}
});

test('codeActions 只接受 retry/fallback/fail', () => {
	assert.deepEqual(validateCodeActions({ SERVER: 'retry', AUTH: 'fallback' }), []);
	const errors = validateCodeActions({ SERVER: 'nope' });
	assert.equal(errors.length, 1);
	assert.match(errors[0], /retry\/fallback\/fail/);
});

test('链校验：空链合法（dormant），重复/自指/非法数值被拒绝', () => {
	assert.deepEqual(validateChain('fallback', []), []);
	assert.deepEqual(validateChain('fallback', [{ provider: 'p', model: 'm' }]), []);

	const duplicate = validateChain('fallback', [
		{ provider: 'p', model: 'm' },
		{ provider: 'p', model: 'm' },
	]);
	assert.ok(duplicate.some((error) => /duplicates/.test(error)));

	const self = validateChain('fallback', [{ provider: 'fallback', model: 'm' }]);
	assert.ok(self.some((error) => /must not equal the wrapper route/.test(error)));

	const bad = validateChain('fallback', [{ provider: 'p', model: 'm', multiplier: 1 }]);
	assert.ok(bad.some((error) => /multiplier must be > 1/.test(error)));

	const missing = validateChain('fallback', [{ provider: '', model: '' }]);
	assert.ok(missing.some((error) => /provider must be a non-empty string/.test(error)));
	assert.ok(missing.some((error) => /model must be a non-empty string/.test(error)));
});

test('enabled: false 的 target 不参与校验、复制检测和路由', () => {
	assert.deepEqual(
		validateChain('fallback', [
			{ provider: 'p', model: 'm' },
			{ provider: 'p', model: 'm', enabled: false },
		]),
		[],
	);
	assert.deepEqual(validateChain('fallback', [{ provider: '', model: '', enabled: false }]), []);
	const indexed = validateChain('fallback', [
		{ provider: 'p', model: 'm', enabled: false },
		{ provider: '', model: '' },
	]);
	assert.ok(indexed.some((error) => error.startsWith('targets[1].provider')), indexed.join('; '));
	assert.deepEqual(
		enabledTargets([
			{ provider: 'p1', model: 'm1' },
			{ provider: 'p2', model: 'm2', enabled: false },
			{ provider: 'p3', model: 'm3', enabled: true },
		]).map((target) => target.provider),
		['p1', 'p3'],
	);
});

test('target 身份与显示名', () => {
	assert.equal(targetKey({ provider: 'opendesign', model: 'eco' }), 'opendesign\u0000eco');
	assert.equal(targetLabel({ provider: 'opendesign', model: 'eco' }), 'opendesign/eco');
	assert.equal(targetLabel({ provider: 'opendesign', model: 'eco', label: '主路由' }), '主路由');
});

test('熔断：阈值、锁、half-open 探活、成功恢复', () => {
	let clock = 1000;
	const breaker = new CircuitBreaker({ failureThreshold: 2, lockMs: 100, now: () => clock });

	assert.equal(breaker.state('k'), BREAKER_STATES.CLOSED);
	breaker.recordFailure('k');
	assert.equal(breaker.state('k'), BREAKER_STATES.CLOSED);
	breaker.recordFailure('k');
	assert.equal(breaker.state('k'), BREAKER_STATES.OPEN);

	// 锁内不允许探活
	assert.equal(breaker.beginProbe('k'), false);
	clock = 1101;
	assert.equal(breaker.state('k'), BREAKER_STATES.HALF_OPEN);
	assert.equal(breaker.beginProbe('k'), true);
	assert.equal(breaker.state('k'), BREAKER_STATES.PROBING);
	assert.equal(breaker.beginProbe('k'), false, '同一 target 同时只能有一个探活');

	breaker.probeFailed('k');
	assert.equal(breaker.state('k'), BREAKER_STATES.OPEN);

	clock = 1202;
	assert.equal(breaker.state('k'), BREAKER_STATES.HALF_OPEN);
	assert.equal(breaker.beginProbe('k'), true);
	breaker.probeSucceeded('k');
	assert.equal(breaker.state('k'), BREAKER_STATES.CLOSED);
	assert.equal(breaker.entries.size, 0);
});

test('熔断：锁住期间再失败会延长锁', () => {
	let clock = 1000;
	const breaker = new CircuitBreaker({ failureThreshold: 1, lockMs: 100, now: () => clock });
	breaker.recordFailure('k');
	clock = 1050;
	breaker.recordFailure('k');
	assert.equal(breaker.state('k'), BREAKER_STATES.OPEN);
	clock = 1101;
	assert.equal(breaker.state('k'), BREAKER_STATES.OPEN, '锁被延长到 1150');
	clock = 1151;
	assert.equal(breaker.state('k'), BREAKER_STATES.HALF_OPEN);
});

test('熔断：快照可序列化并能恢复；未知版本安全降级', () => {
	let clock = 1000;
	const breaker = new CircuitBreaker({ failureThreshold: 1, lockMs: 100, now: () => clock });
	breaker.recordFailure('k');
	const snapshot = breaker.snapshot();
	assert.equal(snapshot.version, 1);

	const restored = CircuitBreaker.fromSnapshot(snapshot, { now: () => clock });
	assert.equal(restored.state('k'), BREAKER_STATES.OPEN);

	clock = 1101;
	assert.equal(restored.state('k'), BREAKER_STATES.HALF_OPEN);

	const unknown = CircuitBreaker.fromSnapshot({ version: 99, entries: { k: {} } });
	assert.equal(unknown.state('k'), BREAKER_STATES.CLOSED);
});

test('AttemptBudget：deadline 与次数上限各自独立，0 表示不限制', () => {
	let clock = 1000;
	const unlimited = new AttemptBudget({ maxTotalMs: 0, maxAttempts: 0 }, () => clock);
	assert.equal(unlimited.remainingMs(), Infinity);
	unlimited.take();
	assert.equal(unlimited.stopReason(), undefined);

	const byDeadline = new AttemptBudget({ maxTotalMs: 1000, maxAttempts: 0 }, () => clock);
	assert.equal(byDeadline.remainingMs(), 1000);
	assert.equal(byDeadline.stopReason(), undefined);
	clock = 1500;
	assert.equal(byDeadline.remainingMs(), 500);
	clock = 2000;
	assert.equal(byDeadline.remainingMs(), 0);
	assert.equal(byDeadline.stopReason(), 'deadline');

	const byAttempts = new AttemptBudget({ maxTotalMs: 0, maxAttempts: 2 }, () => clock);
	assert.equal(byAttempts.stopReason(), undefined);
	byAttempts.take();
	byAttempts.take();
	assert.equal(byAttempts.stopReason(), 'attempts');
	assert.equal(byAttempts.remainingMs(), Infinity);
});

test('AttemptBudget：deadline 先到时报 deadline，而不是 attempts', () => {
	let clock = 0;
	const budget = new AttemptBudget({ maxTotalMs: 10, maxAttempts: 1 }, () => clock);
	budget.take();
	clock = 11;
	assert.equal(budget.stopReason(), 'deadline');
});

test('运行状态快照：每个 target 一行，含状态/连败/锁到期/锁次数', () => {
	let clock = 1000;
	const breaker = new CircuitBreaker({ failureThreshold: 1, lockMs: 500, now: () => clock });
	const targets = [
		{ provider: 'p1', model: 'm1', label: '主路由' },
		{ provider: 'p2', model: 'm2' },
	];
	breaker.recordFailure(targetKey(targets[0]));
	const snapshot = runtimeSnapshot(targets, breaker, clock);
	assert.equal(snapshot.version, 1);
	assert.equal(snapshot.updatedAt, 1000);
	assert.deepEqual(snapshot.targets[0], {
		key: 'p1\u0000m1',
		label: '主路由',
		state: 'open',
		failures: 1,
		lockedUntil: 1500,
		locks: 1,
	});
	assert.deepEqual(snapshot.targets[1], {
		key: 'p2\u0000m2',
		label: 'p2/m2',
		state: 'closed',
		failures: 0,
		lockedUntil: 0,
		locks: 0,
	});
});

test('快照合并：按锁更晚/连败更多/锁次数更多排序，未出现的 key 保留', () => {
	const base = {
		version: 1,
		entries: {
			a: { failures: 2, openedAt: 100, lockedUntil: 1000, locks: 1 },
			only: { failures: 1, openedAt: 100, lockedUntil: 500, locks: 1 },
		},
		cleared: {},
	};
	const incoming = {
		version: 1,
		entries: {
			a: { failures: 1, openedAt: 100, lockedUntil: 2000, locks: 1 },
			b: { failures: 3, openedAt: 100, lockedUntil: 2000, locks: 2 },
		},
		cleared: {},
	};
	const merged = mergeBreakerSnapshots(base, incoming);
	assert.equal(merged.entries.a.lockedUntil, 2000, '锁更晚的胜出');
	assert.equal(merged.entries.b.failures, 3);
	assert.equal(merged.entries.only.lockedUntil, 500, 'base 独有 key 不被删除');

	const older = mergeBreakerSnapshots(merged, {
		version: 1,
		entries: { a: { failures: 9, openedAt: 100, lockedUntil: 1500, locks: 1 } },
		cleared: {},
	});
	assert.equal(older.entries.a.lockedUntil, 2000, '更早的锁不能覆盖');
});

test('快照合并：tombstone 删除更早的锁，保留之后新开的锁', () => {
	const base = {
		version: 1,
		entries: { k: { failures: 5, openedAt: 1000, lockedUntil: 9000, locks: 2 } },
		cleared: {},
	};
	const cleared = mergeBreakerSnapshots(base, { version: 1, entries: {}, cleared: { k: 2000 } });
	assert.equal(cleared.entries.k, undefined);
	assert.equal(cleared.cleared.k, 2000);

	const reLocked = mergeBreakerSnapshots(cleared, {
		version: 1,
		entries: { k: { failures: 1, openedAt: 3000, lockedUntil: 12000, locks: 1 } },
		cleared: {},
	});
	assert.equal(reLocked.entries.k.lockedUntil, 12000);

	const stale = mergeBreakerSnapshots(cleared, {
		version: 1,
		entries: { k: { failures: 5, openedAt: 1000, lockedUntil: 9000, locks: 2 } },
		cleared: {},
	});
	assert.equal(stale.entries.k, undefined, '被清除前的旧锁不能靠合并复活');
});

test('快照合并：非法的 cleared 值被忽略', () => {
	const base = { version: 1, entries: { k: { openedAt: 1, lockedUntil: 2, failures: 1, locks: 1 } }, cleared: {} };
	const merged = mergeBreakerSnapshots(base, {
		version: 1,
		entries: {},
		cleared: { k: Number.NaN, other: Infinity },
	});
	assert.ok(merged.entries.k !== undefined);
	assert.equal(merged.cleared.k, undefined);
	assert.equal(merged.cleared.other, undefined, 'Infinity 不是有限时间，必须忽略');
});

test('快照合并：成功之后重新累计的连败能落盘（不能只有开锁那一次才写）', () => {
	// 线上场景：eco 在 21:51:51 成功过（tombstone），之后又连败到阈值在 21:52:04 开锁。
	// 未达阈值的条目 openedAt 是 null，旧实现拿 0 比 tombstone → 永远写不进磁盘，
	// 进程重启后连败数归零，等于「重启即重置熔断」，阈值形同虚设。
	const key = 'p\u0000m';
	const disk = { version: 1, entries: {}, cleared: { [key]: 5000 } };
	const mine = {
		version: 1,
		entries: { [key]: { failures: 3, openedAt: null, lockedUntil: null, probing: false, locks: 0, updatedAt: 6000 } },
		cleared: {},
	};

	const merged = mergeBreakerSnapshots(disk, mine);
	assert.equal(merged.entries[key]?.failures, 3, '阈值之前的连败必须保留');

	// 反向：tombstone 比连败更新时，旧连败仍要被清掉（成功的语义不能丢）。
	const newerSuccess = mergeBreakerSnapshots(
		{ version: 1, entries: { [key]: { failures: 3, openedAt: null, lockedUntil: null, locks: 0, updatedAt: 6000 } }, cleared: {} },
		{ version: 1, entries: {}, cleared: { [key]: 7000 } },
	);
	assert.equal(newerSuccess.entries[key], undefined, '成功之后的旧连败要被清掉');

	// 反向：旧连败（updatedAt 更早）不能复活已被清除的条目。
	const staleFailures = mergeBreakerSnapshots(
		{ version: 1, entries: {}, cleared: { [key]: 7000 } },
		{ version: 1, entries: { [key]: { failures: 3, openedAt: null, lockedUntil: null, locks: 0, updatedAt: 6000 } }, cleared: {} },
	);
	assert.equal(staleFailures.entries[key], undefined, '清除前的连败不能靠合并复活');
});

test('快照合并：旧格式条目（没有 updatedAt）按 openedAt 兼容', () => {
	const key = 'p\u0000m';
	const legacy = { version: 1, entries: { [key]: { failures: 5, openedAt: 1000, lockedUntil: 9000, locks: 2 } }, cleared: {} };

	// 旧条目 + 更晚的清除 → 删掉。
	const clearedLater = mergeBreakerSnapshots(legacy, { version: 1, entries: {}, cleared: { [key]: 2000 } });
	assert.equal(clearedLater.entries[key], undefined);

	// 旧条目 + 更早的清除 → 保留（条目本身比清除新）。
	const olderClear = mergeBreakerSnapshots(
		{ version: 1, entries: {}, cleared: { [key]: 500 } },
		legacy,
	);
	assert.equal(olderClear.entries[key]?.lockedUntil, 9000);
});

test('熔断快照包含成功清除的时间，且 24 小时后裁剪', () => {
	let clock = 1000;
	const breaker = new CircuitBreaker({ failureThreshold: 1, lockMs: 100, now: () => clock });
	breaker.recordSuccess('k');
	assert.equal(breaker.snapshot().cleared.k, 1000);
	clock = 1000 + 24 * 3600 * 1000 + 1;
	assert.equal(breaker.snapshot().cleared.k, undefined);
});

test('链执行计划：被锁的 target 被跳过，half-open 保留给探活', () => {
	let clock = 1000;
	const breaker = new CircuitBreaker({ failureThreshold: 1, lockMs: 100, now: () => clock });
	const targets = [
		{ provider: 'opendesign', model: 'eco' },
		{ provider: 'deepseek', model: 'flash' },
	];
	breaker.recordFailure(targetKey(targets[0]));

	let attempts = planAttempts(targets, breaker, clock);
	assert.deepEqual(attempts.map(({ state }) => state), [BREAKER_STATES.OPEN, BREAKER_STATES.CLOSED]);
	assert.deepEqual(usableAttempts(attempts).map(({ label }) => label), ['deepseek/flash']);

	clock = 1101;
	attempts = planAttempts(targets, breaker, clock);
	assert.deepEqual(attempts.map(({ state }) => state), [BREAKER_STATES.HALF_OPEN, BREAKER_STATES.CLOSED]);
	assert.equal(usableAttempts(attempts).length, 2, 'half-open 仍应出现在计划里，交给适配器先探活');
});

test('错误分类：网关包装的上游 400（upstream_error）是 target 级故障，必须 fallback 到下一个 target', () => {
	// 线上原文（2026-11-24 会话 7fb5e567 turn 12）：pi-ai 见到 "400" 就判 INVALID_REQUEST，
	// 但请求体本身没问题 —— 同一个 payload 发给链上第二个 target 返回 200。
	const failure = {
		code: 'INVALID_REQUEST',
		message:
			'400: {"message":"[code=upstream_error] The request could not be completed.","type":"upstream_error","code":"upstream_error"}',
	};
	assert.deepEqual(classifyFailure(failure), {
		action: ACTIONS.FALLBACK,
		code: 'INVALID_REQUEST',
		reason: 'upstream-wrapper',
	});

	// 真正的请求错误（本地校验/参数缺失/载荷过大）仍然 fail，不能换 target。
	const genuine = {
		code: 'INVALID_REQUEST',
		message: '400: {"error":{"message":"tools[0]: missing field `type`"}}',
	};
	assert.equal(classifyFailure(genuine).action, ACTIONS.FAIL);

	// 显式覆盖优先于包装识别。
	assert.deepEqual(classifyFailure(failure, { INVALID_REQUEST: 'fail' }), {
		action: ACTIONS.FAIL,
		code: 'INVALID_REQUEST',
		reason: 'override',
	});
	assert.deepEqual(classifyFailure(failure, { INVALID_REQUEST: 'retry' }), {
		action: ACTIONS.RETRY,
		code: 'INVALID_REQUEST',
		reason: 'override',
	});
});

test('包装识别只作用于 4xx 派生的 INVALID_REQUEST，不改变 500 的重试语义', () => {
	const wrapped = { message: '[code=internal_error] failed to evaluate membership entitlement' };
	assert.equal(classifyFailure({ ...wrapped, code: 'SERVER' }).action, ACTIONS.FALLBACK);
	assert.equal(classifyFailure({ ...wrapped, code: 'SERVER' }).reason, 'entitlement');
	const plainServer = { code: 'SERVER', message: '500: {"code":"internal_error","message":"boom"}' };
	assert.equal(classifyFailure(plainServer).action, ACTIONS.RETRY);
});

test('探活是否「有定论」：探针自身局限不算 target 病理证据', async () => {
	const { isConclusiveProbeFailure } = await import('../lib/policy.js');

	// 无定论：探针只有 1 token、内容是一句 ping，这些 code 描述的是探针本身。
	for (const code of ['EMPTY_RESPONSE', 'INVALID_REQUEST', 'MALFORMED_RESPONSE']) {
		assert.equal(isConclusiveProbeFailure({ code, message: 'probe artifact' }), false, code);
	}

	// 有定论：真实请求同样会撞上，必须继续锁。
	assert.equal(isConclusiveProbeFailure({ code: 'SERVER', message: 'down' }), true);
	assert.equal(isConclusiveProbeFailure({ code: 'AUTH', message: 'bad key' }), true);
	assert.equal(isConclusiveProbeFailure({ code: 'EMPTY_RESPONSE', message: '' }), false);

	// 例外：网关包装的上游故障即使在无定论集合里，也是明确的 target 病理证据。
	assert.equal(
		isConclusiveProbeFailure({
			code: 'INVALID_REQUEST',
			message: '400: {"message":"[code=upstream_error] The request could not be completed.","code":"upstream_error"}',
		}),
		true,
	);
});

test('probeInconclusive 和探活成功同路径：解锁并写 tombstone，旧锁不会被合并复活', async () => {
	const { CircuitBreaker, BREAKER_STATES } = await import('../lib/policy.js');
	let now = 1000;
	const breaker = new CircuitBreaker({ failureThreshold: 1, lockMs: 500, now: () => now });
	const key = 'p\u0000m';

	breaker.recordFailure(key);
	assert.equal(breaker.state(key), BREAKER_STATES.OPEN);

	now += 501;
	assert.equal(breaker.state(key), BREAKER_STATES.HALF_OPEN);
	assert.equal(breaker.beginProbe(key), true);
	assert.equal(breaker.state(key), BREAKER_STATES.PROBING);

	breaker.probeInconclusive(key);
	assert.equal(breaker.state(key), BREAKER_STATES.CLOSED, 'inconclusive probe releases the lock');
	// tombstone 是关键：跨进程合并靠 cleared 压制别人磁盘上的旧锁。
	assert.ok(breaker.tombstones.has(key), 'inconclusive probe must leave a tombstone');

	// 另一进程磁盘上那份更晚的旧锁，不能把这里的解锁顶回去。
	const staleLock = {
		version: 1,
		entries: { [key]: { failures: 1, lockedUntil: now + 999_999, locks: 1, updatedAt: now - 1 } },
		cleared: {},
	};
	const { mergeBreakerSnapshots } = await import('../lib/policy.js');
	const merged = mergeBreakerSnapshots(staleLock, breaker.snapshot());
	assert.equal(merged.entries[key], undefined, 'the tombstone wins over a stale lock');
});
