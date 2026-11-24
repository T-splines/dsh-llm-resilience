import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { FallbackAdapter } from '../lib/adapter.js';
import { BREAKER_STATES, targetKey } from '../lib/policy.js';

function target(provider, model, overrides = {}) {
	return {
		provider,
		model,
		maxRetries: 0,
		initialDelayMs: 100,
		multiplier: 2,
		maxDelayMs: 1000,
		jitterRatio: 0,
		...overrides,
	};
}

function makeConfig(targets, { breaker = {}, codeActions = {}, enabled = true, toolCalls = {}, limits = {} } = {}) {
	return {
		enabled,
		route: 'fallback',
		targets,
		breaker: {
			failureThreshold: 5,
			lockMs: 1000,
			probe: { enabled: false, background: false, timeoutMs: 1000, maxTokens: 1, prompt: 'ping' },
			// 单测绝不能落到线上的 $DSH_HOME/storages/llm-fallback/state.json：
			// schema 的默认值会真的读写它，导致测试之间互相污染、也会改坏线上熔断状态。
			// 空串经 expandStateFile() 视为“不持久化”。
			stateFile: '',
			...breaker,
		},
		limits: { maxTotalMs: 0, maxAttempts: 0, ...limits },
		toolCalls: { retryMalformed: true, ...toolCalls },
		codeActions,
	};
}

function createLlm(scripts = {}, modelInfo = {}) {
	const calls = [];
	return {
		calls,
		modelInfo,
		async resolveModelInfo(provider, model) {
			const info = this.modelInfo[`${provider}/${model}`];
			if (info instanceof Error) throw info;
			return info ?? { provider, id: model, name: model };
		},
		stream(options) {
			calls.push(options);
			const key = `${options.provider}/${options.model}`;
			const queue = scripts[key];
			if (!Array.isArray(queue) || queue.length === 0) {
				return (async function* () {
					throw new Error(`no scripted response for ${key}`);
				})();
			}
			const attempt = queue.shift();
			return (async function* () {
				if (attempt instanceof Error) throw attempt;
				yield* attempt;
			})();
		},
	};
}

function textChunks(value = 'ok', index = 0) {
	return [
		{ type: 'block-start', index, blockType: 'text' },
		{ type: 'text-delta', index, text: value },
		{ type: 'block-end', index, block: { type: 'text', text: value } },
	];
}

function toolChunks(args = '{"q":"x"}', index = 0) {
	return [
		{ type: 'block-start', index, blockType: 'tool-call' },
		{ type: 'tool-call-delta', index, id: 'call-1', name: 'search', argumentsDelta: args },
		{ type: 'block-end', index, block: { type: 'tool-call', id: 'call-1', name: 'search', arguments: args } },
	];
}

function usageChunk(value = 1) {
	return { type: 'usage', usage: { inputTokens: value, outputTokens: value } };
}

function stopChunk(replayState) {
	return { type: 'finish', reason: { kind: 'stop' }, ...(replayState === undefined ? {} : { replayState }) };
}

function errorChunk(code, message) {
	return { type: 'finish', reason: { kind: 'error', failure: { message, code } } };
}

function okAttempt(value = 'ok', replayState) {
	return [...textChunks(value), usageChunk(), stopChunk(replayState)];
}

function makeAdapter(
	config,
	llm,
	{ now = () => 1000, random = () => 0.5, onSleep, runtimeRef, recordSession = () => {} } = {},
) {
	const sleeps = [];
	const warnings = [];
	const adapter = new FallbackAdapter({
		route: 'fallback',
		config,
		llm,
		logger: { warn: (message) => warnings.push(message), info: () => {} },
		now,
		random,
		runtimeRef,
		recordSession,
		sleep: async (ms, signal) => {
			sleeps.push(ms);
			if (onSleep) return onSleep(ms, signal);
			return signal?.aborted !== true;
		},
	});
	return { adapter, sleeps, warnings };
}

async function collect(iterable) {
	const chunks = [];
	for await (const chunk of iterable) chunks.push(chunk);
	return chunks;
}

async function collectSettled(iterable) {
	const chunks = [];
	const iterator = iterable[Symbol.asyncIterator]();
	try {
		while (true) {
			const next = await iterator.next();
			if (next.done) return { chunks, error: undefined };
			chunks.push(next.value);
		}
	} catch (error) {
		return { chunks, error };
	}
}

const streamOptions = { provider: 'fallback', model: 'auto', messages: [] };

function midStreamFailure(code = 'SERVER', message = 'mid-stream') {
	return [
		{ type: 'block-start', index: 0, blockType: 'text' },
		{ type: 'text-delta', index: 0, text: 'partial' },
		errorChunk(code, message),
	];
}

function userMessage(id) {
	return { role: 'user', id, content: [{ type: 'text', text: 'hi' }] };
}

test('正常路径：第一个 target 成功，不触碰第二个', async () => {
	const llm = createLlm({
		'p1/m1': [okAttempt('hello')],
		'p2/m2': [okAttempt('other')],
	});
	const { adapter } = makeAdapter(makeConfig([target('p1', 'm1'), target('p2', 'm2')]), llm);

	const chunks = await collect(adapter.stream(streamOptions));

	assert.deepEqual(
		chunks.map((chunk) => chunk.type),
		['block-start', 'text-delta', 'block-end', 'usage', 'finish'],
	);
	assert.equal(llm.calls.length, 1);
	assert.equal(llm.calls[0].provider, 'p1');
	assert.equal(llm.calls[0].model, 'm1');
});

test('enabled: false 的 target 不参与路由；全部禁用等于没有链', async () => {
	const llm = createLlm({
		'p1/m1': [okAttempt('first')],
		'p2/m2': [okAttempt('second')],
	});
	const { adapter } = makeAdapter(
		makeConfig([{ ...target('p1', 'm1'), enabled: false }, target('p2', 'm2')]),
		llm,
	);
	await collect(adapter.stream(streamOptions));
	assert.deepEqual(
		llm.calls.map((call) => `${call.provider}/${call.model}`),
		['p2/m2'],
	);

	const allDisabled = makeAdapter(makeConfig([{ ...target('p1', 'm1'), enabled: false }]), llm);
	await assert.rejects(() => collect(allDisabled.adapter.stream(streamOptions)), /no targets configured/);
	assert.deepEqual(await allDisabled.adapter.listModels('fallback'), []);
});

test('权益 500：直接 fallback，不消耗该 target 的重试预算', async () => {
	const llm = createLlm({
		'p1/m1': [errorChunk('SERVER', '500 failed to evaluate membership entitlement')],
		'p2/m2': [okAttempt('backup')],
	});
	const { adapter, sleeps } = makeAdapter(
		makeConfig([target('p1', 'm1', { maxRetries: 3 }), target('p2', 'm2')]),
		llm,
	);

	const chunks = await collect(adapter.stream(streamOptions));

	assert.equal(llm.calls.length, 2);
	assert.equal(llm.calls[1].provider, 'p2');
	assert.deepEqual(sleeps, []);
	assert.equal(chunks.at(-1).reason.kind, 'stop');
});

test('瞬时错误：按该 target 的退避曲线重试，成功后不再 fallback', async () => {
	const llm = createLlm({
		'p1/m1': [
			[errorChunk('SERVER', 'boom')],
			[errorChunk('TIMEOUT', 'slow')],
			okAttempt('recovered'),
		],
		'p2/m2': [okAttempt('should not be used')],
	});
	const { adapter, sleeps } = makeAdapter(
		makeConfig([target('p1', 'm1', { maxRetries: 2, initialDelayMs: 100, multiplier: 2 }), target('p2', 'm2')]),
		llm,
	);

	const chunks = await collect(adapter.stream(streamOptions));

	assert.deepEqual(sleeps, [100, 200]);
	assert.equal(llm.calls.length, 3);
	assert.equal(chunks.at(-1).reason.kind, 'stop');
});

test('重试耗尽：切到下一个 target，且退避从新 target 的 initialDelay 重新起算', async () => {
	const llm = createLlm({
		'p1/m1': [[errorChunk('SERVER', 'boom')], [errorChunk('SERVER', 'boom')]],
		'p2/m2': [[errorChunk('SERVER', 'also boom')], okAttempt('backup')],
	});
	const { adapter, sleeps } = makeAdapter(
		makeConfig([
			target('p1', 'm1', { maxRetries: 1, initialDelayMs: 100, multiplier: 2 }),
			target('p2', 'm2', { maxRetries: 1, initialDelayMs: 50, multiplier: 2 }),
		]),
		llm,
	);

	const chunks = await collect(adapter.stream(streamOptions));

	assert.deepEqual(sleeps, [100, 50]);
	assert.equal(llm.calls.filter((call) => call.provider === 'p1').length, 2);
	assert.equal(llm.calls.filter((call) => call.provider === 'p2').length, 2);
	assert.equal(chunks.at(-1).reason.kind, 'stop');
});

test('文本已交付后失败：不换 target，抛原始 code 给宿主的整步重放', async () => {
	const llm = createLlm({
		'p1/m1': [
			[
				{ type: 'block-start', index: 0, blockType: 'text' },
				{ type: 'text-delta', index: 0, text: 'partial' },
				errorChunk('SERVER', 'mid-stream'),
			],
		],
		'p2/m2': [okAttempt('should not be used')],
	});
	const { adapter } = makeAdapter(
		makeConfig([target('p1', 'm1', { maxRetries: 3 }), target('p2', 'm2')]),
		llm,
	);

	const { chunks, error } = await collectSettled(adapter.stream(streamOptions));

	assert.equal(error.code, 'SERVER');
	assert.match(error.message, /not switching targets/);
	assert.equal(llm.calls.length, 1);
	assert.deepEqual(chunks.map((chunk) => chunk.type), ['block-start', 'text-delta']);
});

test('step 重放：内容已交付后失败，同指纹的下一次请求从下一个 target 继续', async () => {
	const llm = createLlm({
		'p1/m1': [midStreamFailure()],
		'p2/m2': [okAttempt('recovered')],
	});
	const { adapter } = makeAdapter(makeConfig([target('p1', 'm1'), target('p2', 'm2')]), llm);
	const messages = [userMessage('u1')];

	const first = await collectSettled(
		adapter.stream({ ...streamOptions, sessionId: 's1', messages }),
	);
	assert.equal(first.error.code, 'SERVER');

	const second = await collect(adapter.stream({ ...streamOptions, sessionId: 's1', messages }));
	assert.equal(llm.calls.filter((call) => call.provider === 'p1').length, 1);
	assert.equal(llm.calls.filter((call) => call.provider === 'p2').length, 1);
	assert.equal(second.at(-1).reason.kind, 'stop');
});

test('step 重放提示：请求指纹不同则丢弃，不会误跳过第一个 target', async () => {
	const llm = createLlm({
		'p1/m1': [midStreamFailure(), okAttempt('p1 recovered')],
		'p2/m2': [okAttempt('p2')],
	});
	const { adapter } = makeAdapter(makeConfig([target('p1', 'm1'), target('p2', 'm2')]), llm);

	await collectSettled(
		adapter.stream({ ...streamOptions, sessionId: 's1', messages: [userMessage('u1')] }),
	);
	const second = await collect(
		adapter.stream({ ...streamOptions, sessionId: 's1', messages: [userMessage('u2')] }),
	);

	assert.equal(llm.calls.filter((call) => call.provider === 'p1').length, 2);
	assert.equal(llm.calls.filter((call) => call.provider === 'p2').length, 0);
	assert.equal(second.at(-1).reason.kind, 'stop');
});

test('step 重放落在链尾：重试该 target，而不是把可重试失败改写成 FALLBACK_EXHAUSTED', async () => {
	// 线上复现（2026-11-10 22:00，会话 c4f3504f）：eco 已被熔断锁住，链上只剩
	// OpenDesign；它吐了 reasoning 后断流 → 宿主整步重放 → 旧实现切出空链，
	// 立刻抛 FALLBACK_EXHAUSTED，OpenDesign 只得到 1 次尝试就整轮失败。
	const llm = createLlm({
		// p1 没有脚本 ⇒ 每次必失败（UNKNOWN → fallback）。p2 前 5 次成功用于预热，
		// 第 6 次是真实 step（交付 reasoning 后断流），第 7 次是宿主的整步重放。
		'p2/m2': [
			okAttempt('warm-1'),
			okAttempt('warm-2'),
			okAttempt('warm-3'),
			okAttempt('warm-4'),
			okAttempt('warm-5'),
			midStreamFailure('TRANSPORT', 'terminated'),
			okAttempt('recovered'),
		],
	});
	const config = makeConfig([target('p1', 'm1'), target('p2', 'm2')], {
		breaker: { failureThreshold: 5, lockMs: 60000 },
	});
	const { adapter } = makeAdapter(config, llm, { now: () => 1000 });

	// 预热：p1 没有脚本（必失败），p2 正常；5 次后 p1 达到阈值被锁。
	for (let index = 0; index < 5; index += 1) {
		await collect(adapter.stream({ ...streamOptions, sessionId: `warm-${index}`, messages: [userMessage(`u${index}`)] }));
	}
	const p1 = targetKey({ provider: 'p1', model: 'm1' });
	assert.equal(adapter.breaker.state(p1), BREAKER_STATES.OPEN, '预热后 p1 应被锁');

	// 真实 step：只剩 p2，它交付 reasoning 后断流 → 记下「已试到链尾」的提示。
	const messages = [userMessage('u-real')];
	const first = await collectSettled(adapter.stream({ ...streamOptions, sessionId: 's1', messages }));
	assert.equal(first.error.code, 'TRANSPORT', '链尾失败原样抛出，交给宿主整步重放');

	// 宿主第一次重放：旧实现这里直接 FALLBACK_EXHAUSTED 且一次上游都不发。
	const second = await collectSettled(adapter.stream({ ...streamOptions, sessionId: 's1', messages }));
	assert.equal(second.error, undefined, '重放必须真的再试一次链尾 target');
	assert.equal(second.chunks.at(-1).reason.kind, 'stop');
	assert.equal(
		llm.calls.filter((call) => call.provider === 'p2').length,
		7,
		'预热 5 次 + 首轮 1 次 + 重放 1 次',
	);
});

test('step 重放：轮转后仍然包含被跳过的 target，不会被截断成只剩后半条链', async () => {
	// 线上复现（2026-11-11 21:41，会话 54e71f76）：eco 交付 reasoning 后断流 → 宿主
	// 整步重放 → 旧实现把计划截断成 [OpenDesign] → OpenDesign 撞上网关瞬时的
	// entitlement 500（非重试、直接 fallback）→ 链空 → FALLBACK_EXHAUSTED
	// 「1 target(s) failed」，而 eco 那时已经恢复。续点必须是轮转，不是截断。
	// 网关在**任何内容之前**就拒绝：没有交付 ⇒ 分类为 fallback，可以换 target。
	const entitlement = [
		errorChunk(
			'SERVER',
			'500: {"code":"internal_error","message":"[code=internal_error] failed to evaluate membership entitlement"}',
		),
	];
	const llm = createLlm({
		'p1/m1': [midStreamFailure('TRANSPORT', 'terminated'), okAttempt('eco recovered')],
		'p2/m2': [entitlement],
	});
	const { adapter } = makeAdapter(makeConfig([target('p1', 'm1'), target('p2', 'm2')]), llm);
	const messages = [userMessage('u1')];

	const first = await collectSettled(adapter.stream({ ...streamOptions, sessionId: 's1', messages }));
	assert.equal(first.error.code, 'TRANSPORT', '首轮：p1 交付后断流');

	// 重放：从 p2 开始，p2 被 entitlement 挡住后必须绕回 p1，而不是就此判定链耗尽。
	const second = await collectSettled(adapter.stream({ ...streamOptions, sessionId: 's1', messages }));
	assert.equal(second.error, undefined, '被跳过的 target 必须还能被尝试');
	assert.equal(second.chunks.at(-1).reason.kind, 'stop');
	assert.deepEqual(
		llm.calls.map((call) => call.provider),
		['p1', 'p2', 'p1'],
		'轮转顺序：失败的 p1 → 下一个 p2 → 绕回 p1',
	);
});

test('step 重放：失败 target 不在链尾时仍往后跳，不退化成原地重试', async () => {
	// 修复「链尾原地重试」时最容易踩的坑：把所有重放都改成原地重试，
	// 于是重放永远卡在同一个 target 上，后面的 target 再也用不到。
	const llm = createLlm({
		'p1/m1': [midStreamFailure('TRANSPORT', 'terminated')],
		'p2/m2': [midStreamFailure('TRANSPORT', 'terminated')],
		'p3/m3': [okAttempt('final')],
	});
	const { adapter } = makeAdapter(
		makeConfig([target('p1', 'm1'), target('p2', 'm2'), target('p3', 'm3')]),
		llm,
	);
	const messages = [userMessage('u1')];

	const first = await collectSettled(adapter.stream({ ...streamOptions, sessionId: 's1', messages }));
	assert.equal(first.error.code, 'TRANSPORT');
	assert.deepEqual(
		llm.calls.map((call) => call.provider),
		['p1'],
		'首次请求：p1 交付后失败，不换 target',
	);

	const second = await collectSettled(adapter.stream({ ...streamOptions, sessionId: 's1', messages }));
	assert.equal(second.error.code, 'TRANSPORT', '第二次重放跳到 p2，它也交付后失败');
	assert.deepEqual(llm.calls.map((call) => call.provider), ['p1', 'p2'], '重放往后跳一个 target');

	const third = await collectSettled(adapter.stream({ ...streamOptions, sessionId: 's1', messages }));
	assert.equal(third.error, undefined);
	assert.deepEqual(llm.calls.map((call) => call.provider), ['p1', 'p2', 'p3'], '第三次重放到达链尾成功');
	assert.equal(llm.calls.filter((call) => call.provider === 'p1').length, 1, 'p1 不可被原地重试');
	assert.equal(llm.calls.filter((call) => call.provider === 'p2').length, 1, 'p2 同样只试一次');
});

test('工具参数非法：缓冲的 tool-call 被丢弃并重试，宿主只看到成功的那次', async () => {
	const malformed = [
		{ type: 'block-start', index: 0, blockType: 'tool-call' },
		{ type: 'tool-call-delta', index: 0, id: 'call-1', name: 'search', argumentsDelta: '{"q":' },
		errorChunk('MALFORMED_RESPONSE', 'Tool call "search": invalid JSON'),
	];
	const llm = createLlm({
		'p1/m1': [malformed, [...toolChunks('{"q":"x"}'), usageChunk(), stopChunk()]],
	});
	const { adapter, sleeps } = makeAdapter(makeConfig([target('p1', 'm1', { maxRetries: 1 })]), llm);

	const chunks = await collect(adapter.stream(streamOptions));

	assert.deepEqual(sleeps, [100]);
	assert.deepEqual(
		chunks.map((chunk) => chunk.type),
		['block-start', 'tool-call-delta', 'block-end', 'usage', 'finish'],
	);
	assert.equal(chunks[1].argumentsDelta, '{"q":"x"}');
});

test('完整 tool-call 已交付后失败：不重试，避免宿主收到重复工具调用', async () => {
	const llm = createLlm({
		'p1/m1': [[...toolChunks('{}'), errorChunk('SERVER', 'after tool')]],
		'p2/m2': [okAttempt('should not be used')],
	});
	const { adapter } = makeAdapter(
		makeConfig([target('p1', 'm1', { maxRetries: 3 }), target('p2', 'm2')]),
		llm,
	);

	const { chunks, error } = await collectSettled(adapter.stream(streamOptions));

	assert.equal(error.code, 'SERVER');
	assert.equal(llm.calls.length, 1);
	assert.deepEqual(chunks.map((chunk) => chunk.type), ['block-start', 'tool-call-delta', 'block-end']);
});

test('熔断：连续失败达到阈值后，后续请求直接跳过该 target', async () => {
	let now = 1000;
	const llm = createLlm({
		'p1/m1': [[errorChunk('SERVER', 'down')], [errorChunk('SERVER', 'down')]],
		'p2/m2': [okAttempt('a'), okAttempt('b'), okAttempt('c')],
	});
	const { adapter } = makeAdapter(
		makeConfig([target('p1', 'm1'), target('p2', 'm2')], {
			breaker: { failureThreshold: 2, lockMs: 5000 },
		}),
		llm,
		{ now: () => now },
	);

	await collect(adapter.stream(streamOptions));
	await collect(adapter.stream(streamOptions));
	await collect(adapter.stream(streamOptions));

	assert.equal(llm.calls.filter((call) => call.provider === 'p1').length, 2);
	assert.equal(llm.calls.filter((call) => call.provider === 'p2').length, 3);
});

test('半开探活成功：探活后真正使用该 target，成功后清空熔断状态', async () => {
	let now = 1000;
	const llm = createLlm({
		'p1/m1': [[errorChunk('SERVER', 'down')], [usageChunk(), stopChunk()], okAttempt('recovered')],
		'p2/m2': [okAttempt('backup')],
	});
	const { adapter } = makeAdapter(
		makeConfig([target('p1', 'm1'), target('p2', 'm2')], {
			breaker: {
				failureThreshold: 1,
				lockMs: 1000,
				probe: { enabled: true, timeoutMs: 1000, maxTokens: 1, prompt: 'ping' },
			},
		}),
		llm,
		{ now: () => now },
	);

	await collect(adapter.stream(streamOptions));
	const p1CallsAfterOpen = llm.calls.filter((call) => call.provider === 'p1').length;
	assert.equal(p1CallsAfterOpen, 1);

	now += 1001;
	const chunks = await collect(adapter.stream(streamOptions));

	const p1Calls = llm.calls.filter((call) => call.provider === 'p1');
	assert.equal(p1Calls.length, 3);
	assert.equal(p1Calls[1].maxTokens, 1);
	assert.equal(p1Calls[1].messages[0].content[0].text, 'ping');
	assert.equal(p1Calls[2].maxTokens, undefined);
	assert.equal(llm.calls.filter((call) => call.provider === 'p2').length, 1);
	assert.equal(chunks.at(-1).reason.kind, 'stop');
	assert.equal(adapter.breaker.entries.size, 0);
});

test('半开探活失败：重新锁一轮，本次及后续请求继续走下一个 target', async () => {
	let now = 1000;
	const llm = createLlm({
		'p1/m1': [[errorChunk('SERVER', 'down')], [errorChunk('SERVER', 'still down')]],
		'p2/m2': [okAttempt('a'), okAttempt('b'), okAttempt('c')],
	});
	const { adapter } = makeAdapter(
		makeConfig([target('p1', 'm1'), target('p2', 'm2')], {
			breaker: {
				failureThreshold: 1,
				lockMs: 1000,
				probe: { enabled: true, timeoutMs: 1000, maxTokens: 1, prompt: 'ping' },
			},
		}),
		llm,
		{ now: () => now },
	);

	await collect(adapter.stream(streamOptions));
	now += 1001;
	await collect(adapter.stream(streamOptions));
	await collect(adapter.stream(streamOptions));

	assert.equal(llm.calls.filter((call) => call.provider === 'p1').length, 2);
	assert.equal(llm.calls.filter((call) => call.provider === 'p2').length, 3);
	const entry = adapter.breaker.entries.get(targetKey(target('p1', 'm1')));
	assert.equal(entry.probing, false);
	assert.equal(entry.lockedUntil, now + 1000);
});

test('全部 target 被锁：下一次请求明确报 ALL_TARGETS_LOCKED', async () => {
	const llm = createLlm({
		'p1/m1': [[errorChunk('SERVER', 'down')]],
	});
	const { adapter } = makeAdapter(
		makeConfig([target('p1', 'm1')], { breaker: { failureThreshold: 1, lockMs: 1000 } }),
		llm,
	);

	const first = await collectSettled(adapter.stream(streamOptions));
	assert.equal(first.error.code, 'FALLBACK_EXHAUSTED');

	const second = await collectSettled(adapter.stream(streamOptions));
	assert.equal(second.error.code, 'ALL_TARGETS_LOCKED');
});

test('退避等待期间被取消：立即以 aborted finish 结束，不尝试下一个 target', async () => {
	const controller = new AbortController();
	const llm = createLlm({
		'p1/m1': [[errorChunk('SERVER', 'boom')]],
		'p2/m2': [okAttempt('should not be used')],
	});
	const { adapter, sleeps } = makeAdapter(
		makeConfig([target('p1', 'm1', { maxRetries: 3, initialDelayMs: 1000 }), target('p2', 'm2')]),
		llm,
		{
			onSleep: () => {
				controller.abort(new Error('user cancel'));
				return false;
			},
		},
	);

	const chunks = await collect(
		adapter.stream({ ...streamOptions, signal: controller.signal }),
	);

	assert.deepEqual(sleeps, [1000]);
	assert.equal(llm.calls.length, 1);
	assert.deepEqual(chunks.map((chunk) => chunk.type), ['finish']);
	assert.equal(chunks[0].reason.kind, 'aborted');
});

test('replay 信封：返回时包一层 target 身份，下次请求还原成真实 provider/model', async () => {
	const innerState = {
		response: {
			kind: 'pi-ai',
			version: 2,
			api: 'openai-completions',
			provider: 'p1',
			model: 'm1',
			stopReason: 'stop',
		},
		blocks: [{ type: 'text' }],
	};
	const llm = createLlm({
		'p1/m1': [okAttempt('first', innerState), okAttempt('second')],
	});
	const { adapter } = makeAdapter(makeConfig([target('p1', 'm1')]), llm);

	const first = await collect(adapter.stream(streamOptions));
	const finish = first.at(-1);
	assert.equal(finish.replayState.response.kind, 'dsh-llm-resilience');
	assert.deepEqual(finish.replayState.response.inner, innerState.response);
	assert.deepEqual(finish.replayState.blocks, innerState.blocks);

	const history = [
		{
			role: 'assistant',
			id: 'a1',
			content: [{ type: 'text', text: 'first' }],
			source: {
				kind: 'model',
				provider: 'fallback',
				model: 'auto',
				replayState: finish.replayState,
			},
		},
	];
	await collect(adapter.stream({ ...streamOptions, messages: history }));

	const forwarded = llm.calls[1].messages[0];
	assert.equal(forwarded.source.provider, 'p1');
	assert.equal(forwarded.source.model, 'm1');
	assert.deepEqual(forwarded.source.replayState, innerState);
});

test('replay 信封：兼容旧包名 dsh-llm-fallback 写下的历史', async () => {
	const innerState = {
		response: {
			kind: 'pi-ai',
			version: 2,
			api: 'openai-completions',
			provider: 'p1',
			model: 'm1',
			stopReason: 'stop',
		},
		blocks: [{ type: 'text' }],
	};
	const llm = createLlm({ 'p1/m1': [okAttempt('legacy')] });
	const { adapter } = makeAdapter(makeConfig([target('p1', 'm1')]), llm);
	const history = [
		{
			role: 'assistant',
			id: 'a1',
			content: [{ type: 'text', text: 'legacy' }],
			source: {
				kind: 'model',
				provider: 'fallback',
				model: 'auto',
				replayState: {
					response: {
						kind: 'dsh-llm-fallback',
						version: 1,
						provider: 'p1',
						model: 'm1',
						inner: innerState.response,
					},
					blocks: innerState.blocks,
				},
			},
		},
	];

	await collect(adapter.stream({ ...streamOptions, messages: history }));

	const forwarded = llm.calls[0].messages[0];
	assert.equal(forwarded.source.provider, 'p1');
	assert.equal(forwarded.source.model, 'm1');
	assert.deepEqual(forwarded.source.replayState, innerState);
});

test('resolveModel：取能力交集/最小上下文，身份仍是合成 route', async () => {
	const llm = createLlm(
		{},
		{
			'p1/m1': {
				provider: 'p1',
				id: 'm1',
				name: 'M1',
				context: { contextWindow: 1000 },
				defaultMaxTokens: 500,
				inputModalities: ['text', 'image'],
				reasoning: {
					efforts: [
						{ id: 'low', name: 'Low' },
						{ id: 'high', name: 'High' },
					],
					defaultEffort: 'high',
				},
				systemPromptUpdate: 'in-history',
				toolUpdate: 'addition-only',
			},
			'p2/m2': {
				provider: 'p2',
				id: 'm2',
				name: 'M2',
				context: { contextWindow: 2000 },
				defaultMaxTokens: 800,
				inputModalities: ['text'],
				reasoning: {
					efforts: [{ id: 'high', name: 'High' }],
					defaultEffort: 'high',
				},
				systemPromptUpdate: 'in-history',
				toolUpdate: 'in-history',
			},
		},
	);
	const { adapter } = makeAdapter(makeConfig([target('p1', 'm1'), target('p2', 'm2')]), llm);

	const info = await adapter.resolveModel('fallback', 'auto');

	assert.equal(info.provider, 'fallback');
	assert.equal(info.id, 'auto');
	assert.equal(info.context.contextWindow, 1000);
	assert.equal(info.defaultMaxTokens, 500);
	assert.deepEqual(info.inputModalities, ['text']);
	assert.deepEqual(info.reasoning.efforts.map((effort) => effort.id), ['high']);
	assert.equal(info.reasoning.defaultEffort, 'high');
	assert.equal(info.systemPromptUpdate, 'in-history');
	assert.equal(info.toolUpdate, undefined);
});

test('listModels：有链才提供 auto；dormant 时不提供任何模型', async () => {
	const llm = createLlm({});
	const active = makeAdapter(makeConfig([target('p1', 'm1')]), llm).adapter;
	assert.equal((await active.listModels('fallback')).length, 1);
	assert.equal((await active.listModels('fallback'))[0].id, 'auto');

	const dormant = makeAdapter(makeConfig([]), llm).adapter;
	assert.deepEqual(await dormant.listModels('fallback'), []);
});

test('retryMalformed=false：同一 target 不重试，直接 fallback（codeActions 覆盖仍然优先）', async () => {
	const malformed = [
		{ type: 'block-start', index: 0, blockType: 'tool-call' },
		{ type: 'tool-call-delta', index: 0, id: 'call-1', name: 'search', argumentsDelta: '{"q":' },
		errorChunk('MALFORMED_RESPONSE', 'Tool call "search": invalid JSON'),
	];
	const llm = createLlm({
		'p1/m1': [malformed],
		'p2/m2': [okAttempt('backup')],
	});
	const { adapter, sleeps } = makeAdapter(
		makeConfig([target('p1', 'm1', { maxRetries: 3 }), target('p2', 'm2')], {
			toolCalls: { retryMalformed: false },
		}),
		llm,
	);

	const chunks = await collect(adapter.stream(streamOptions));

	assert.deepEqual(sleeps, []);
	assert.equal(llm.calls.filter((call) => call.provider === 'p1').length, 1);
	assert.equal(llm.calls.filter((call) => call.provider === 'p2').length, 1);
	assert.equal(chunks.at(-1).reason.kind, 'stop');
});

test('能力聚合：有 target 明确只收文本时，未知能力的 target 按文本处理', async () => {
	const llm = createLlm(
		{},
		{
			'p1/m1': { provider: 'p1', id: 'm1', name: 'M1', inputModalities: ['text', 'image'] },
			'p2/m2': { provider: 'p2', id: 'm2', name: 'M2' },
		},
	);
	const { adapter } = makeAdapter(makeConfig([target('p1', 'm1'), target('p2', 'm2')]), llm);
	const unknown = await adapter.resolveModel('fallback', 'auto');
	assert.equal(unknown.inputModalities, undefined);

	llm.modelInfo['p2/m2'] = { provider: 'p2', id: 'm2', name: 'M2', inputModalities: ['text'] };
	const conservative = await adapter.resolveModel('fallback', 'auto');
	assert.deepEqual(conservative.inputModalities, ['text']);
});

test('熔断状态持久化：新进程从 stateFile 恢复锁；恢复成功后清空条目', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'dsh-llm-resilience-'));
	const stateFile = join(dir, 'state.json');
	let now = 1000;
	const config = makeConfig([target('p1', 'm1'), target('p2', 'm2')], {
		breaker: { failureThreshold: 1, lockMs: 5000, stateFile },
	});

	const first = makeAdapter(
		config,
		createLlm({
			'p1/m1': [[errorChunk('SERVER', 'down')]],
			'p2/m2': [okAttempt('a')],
		}),
		{ now: () => now },
	);
	await collect(first.adapter.stream(streamOptions));
	await first.adapter.flushState();

	// 模拟进程重启：新的 adapter 从磁盘恢复 p1 的锁，p1 不再被调用。
	const restartedLlm = createLlm({ 'p2/m2': [okAttempt('b')] });
	const restarted = makeAdapter(config, restartedLlm, { now: () => now + 1 });
	const restartedChunks = await collect(restarted.adapter.stream(streamOptions));
	assert.equal(restartedLlm.calls.filter((call) => call.provider === 'p1').length, 0);
	assert.equal(restartedLlm.calls.filter((call) => call.provider === 'p2').length, 1);
	assert.equal(restartedChunks.at(-1).reason.kind, 'stop');

	// 锁到期后恢复成功，持久化条目必须被删除（否则重启会继续误锁）。
	now = 6001;
	const recovered = makeAdapter(
		config,
		createLlm({ 'p1/m1': [okAttempt('recovered')] }),
		{ now: () => now },
	);
	await collect(recovered.adapter.stream(streamOptions));
	await recovered.adapter.flushState();
	assert.deepEqual(JSON.parse(readFileSync(stateFile, 'utf8')).entries, {});
	rmSync(dir, { recursive: true, force: true });
});

test('熔断状态持久化：未达阈值的连败跨进程累计，重启后不会归零', async () => {
	// 线上场景：eco 21:51:51 成功过（tombstone），随后连败到 5 次才在 21:52:04 开锁。
	// 旧实现在成功之后重新累计的连败（openedAt=null）永远写不进磁盘，
	// 进程重启就连败归零 —— 阈值形同虚设。
	const dir = mkdtempSync(join(tmpdir(), 'dsh-llm-resilience-'));
	const stateFile = join(dir, 'state.json');
	let now = 1000;
	const config = makeConfig([target('p1', 'm1'), target('p2', 'm2')], {
		breaker: { failureThreshold: 5, lockMs: 60000, stateFile },
	});
	const p1Key = targetKey({ provider: 'p1', model: 'm1' });

	// 进程 1：先成功一次（写 tombstone），再失败 3 次（未到阈值 5）。
	const warm = makeAdapter(config, createLlm({ 'p1/m1': [okAttempt('ok')], 'p2/m2': [okAttempt('x')] }), {
		now: () => now,
	});
	await collect(warm.adapter.stream(streamOptions));
	await warm.adapter.flushState();

	now = 2000;
	const flaky = makeAdapter(
		config,
		createLlm({
			'p1/m1': [[errorChunk('SERVER', 'down')], [errorChunk('SERVER', 'down')], [errorChunk('SERVER', 'down')]],
			'p2/m2': [okAttempt('a'), okAttempt('b'), okAttempt('c')],
		}),
		{ now: () => now },
	);
	for (let index = 0; index < 3; index += 1) await collect(flaky.adapter.stream(streamOptions));
	await flaky.adapter.flushState();

	assert.equal(
		JSON.parse(readFileSync(stateFile, 'utf8')).entries[p1Key]?.failures,
		3,
		'阈值之前的连败必须落盘',
	);

	// 进程 2（重启）：再失败 2 次就应开锁；连败若被重置，这里会永远开不了锁。
	now = 3000;
	const restarted = makeAdapter(
		config,
		createLlm({ 'p1/m1': [[errorChunk('SERVER', 'down')], [errorChunk('SERVER', 'down')]], 'p2/m2': [okAttempt('d'), okAttempt('e')] }),
		{ now: () => now },
	);
	for (let index = 0; index < 2; index += 1) await collect(restarted.adapter.stream(streamOptions));
	await restarted.adapter.flushState();

	const saved = JSON.parse(readFileSync(stateFile, 'utf8')).entries[p1Key];
	assert.equal(saved.failures, 5, '跨进程累计到阈值');
	assert.equal(saved.lockedUntil, now + 60000, '第 5 次失败必须开锁');
	rmSync(dir, { recursive: true, force: true });
});

test('外层重试策略：只保留整步重放需要的 code，不含 FALLBACK_EXHAUSTED', () => {
	const { adapter } = makeAdapter(makeConfig([]), createLlm({}));
	const policy = adapter.providerRetryPolicy();
	assert.equal(policy.mode, 'normal');
	assert.equal(policy.maxRetries, 3);
	assert.ok(policy.retryableCodes.includes('MALFORMED_RESPONSE'));
	assert.ok(!policy.retryableCodes.includes('FALLBACK_EXHAUSTED'));
	assert.ok(!policy.retryableCodes.includes('ALL_TARGETS_LOCKED'));
	assert.ok(Object.isFrozen(policy));
});

test('请求本身有错：不记熔断、不尝试下一个 target，直接抛原始 code', async () => {
	const llm = createLlm({
		'p1/m1': [[errorChunk('INVALID_REQUEST', 'bad request')]],
		'p2/m2': [okAttempt('should not be used')],
	});
	const { adapter } = makeAdapter(
		makeConfig([target('p1', 'm1', { maxRetries: 3 }), target('p2', 'm2')]),
		llm,
	);

	const { error } = await collectSettled(adapter.stream(streamOptions));

	assert.equal(error.code, 'INVALID_REQUEST');
	assert.equal(llm.calls.length, 1);
	assert.equal(adapter.breaker.entries.size, 0);
});

test('宿主可恢复的请求级错误原样抛出：图片卸载与上下文压缩不会被 fallback 吞掉', async () => {
	for (const failure of [
		{
			code: 'IMAGE_OFFLOAD_REQUIRED',
			message: 'pi-ai request images exceed the route image budget',
			offloadImages: 70,
		},
		{ code: 'CONTEXT_WINDOW_EXCEEDED', message: 'context window exceeded' },
	]) {
		const llm = createLlm({
			'p1/m1': [[{ type: 'finish', reason: { kind: 'error', failure } }]],
			'p2/m2': [okAttempt('should not be used')],
		});
		const { adapter } = makeAdapter(
			makeConfig([target('p1', 'm1', { maxRetries: 3 }), target('p2', 'm2')]),
			llm,
		);

		const { error } = await collectSettled(adapter.stream(streamOptions));

		assert.equal(error.code, failure.code);
		if (failure.offloadImages !== undefined) {
			assert.equal(error.failure.offloadImages, 70, 'offloadImages 必须原样带给宿主');
		}
		assert.equal(llm.calls.length, 1, '请求级错误不换 target');
		assert.equal(adapter.breaker.entries.size, 0, '请求级错误不记熔断');
	}
});

test('空链 / 禁用：分别报 NO_TARGETS 与 DISABLED', async () => {
	await assert.rejects(
		collect(makeAdapter(makeConfig([]), createLlm({})).adapter.stream(streamOptions)),
		(error) => error.code === 'NO_TARGETS',
	);
	await assert.rejects(
		collect(
			makeAdapter(makeConfig([target('p1', 'm1')], { enabled: false }), createLlm({})).adapter.stream(
				streamOptions,
			),
		),
		(error) => error.code === 'DISABLED',
	);
});

test('全局 deadline：重试等待被截断，抛出 DEADLINE_EXCEEDED', async () => {
	let clock = 1000;
	const llm = createLlm({
		'p1/m1': [[errorChunk('SERVER', 'down')], [errorChunk('SERVER', 'down')]],
	});
	const config = makeConfig(
		[target('p1', 'm1', { maxRetries: 5, initialDelayMs: 100, multiplier: 2, maxDelayMs: 1000, jitterRatio: 0 })],
		{ limits: { maxTotalMs: 150 } },
	);
	const { adapter, sleeps } = makeAdapter(config, llm, {
		now: () => clock,
		onSleep: (ms) => {
			clock += ms;
			return true;
		},
	});

	const { error } = await collectSettled(adapter.stream(streamOptions));

	assert.equal(error.code, 'DEADLINE_EXCEEDED');
	assert.deepEqual(sleeps, [100, 50]);
	assert.equal(llm.calls.length, 2);
});

test('全局尝试上限：达到 maxAttempts 后不再发请求', async () => {
	const llm = createLlm({ 'p1/m1': [[errorChunk('SERVER', 'down')]] });
	const config = makeConfig(
		[target('p1', 'm1', { maxRetries: 5, initialDelayMs: 10, maxDelayMs: 10, jitterRatio: 0 })],
		{ limits: { maxAttempts: 1 } },
	);
	const { adapter, sleeps } = makeAdapter(config, llm);

	const { error } = await collectSettled(adapter.stream(streamOptions));

	assert.equal(error.code, 'ATTEMPT_LIMIT');
	assert.equal(llm.calls.length, 1);
	assert.deepEqual(sleeps, []);
});

test('后台探活：当前请求跳过 half-open target，探活成功后下一次恢复使用', async () => {
	let clock = 1000;
	const llm = createLlm({
		'p1/m1': [[errorChunk('SERVER', 'down')], okAttempt('pong'), okAttempt('primary')],
		'p2/m2': [okAttempt('secondary'), okAttempt('secondary2')],
	});
	const config = makeConfig([target('p1', 'm1'), target('p2', 'm2')], {
		breaker: {
			failureThreshold: 1,
			lockMs: 100,
			probe: { enabled: true, background: true, timeoutMs: 1000, maxTokens: 1, prompt: 'ping' },
		},
	});
	const { adapter } = makeAdapter(config, llm, { now: () => clock });

	await collect(adapter.stream(streamOptions));
	assert.equal(adapter.breaker.state('p1\u0000m1'), 'open');

	clock = 1101;
	await collect(adapter.stream(streamOptions));
	await new Promise((resolve) => setTimeout(resolve, 20));

	assert.equal(adapter.breaker.state('p1\u0000m1'), 'closed');
	assert.ok(llm.calls.some((call) => call.provider === 'p1' && call.maxTokens === 1));

	const third = await collect(adapter.stream(streamOptions));
	assert.equal(third.at(-1).reason.kind, 'stop');
	assert.equal(adapter.breaker.state('p1\u0000m1'), 'closed');
	assert.equal(llm.calls.filter((call) => call.provider === 'p1' && call.maxTokens !== 1).length, 2);
});

test('运行状态与 session 事件：retry / fallback / lock 都可见', async () => {
	const published = [];
	const runtimeRef = {
		get: () => undefined,
		[Symbol.for('cosmokit.volatile.write')]: (value) => published.push(value),
	};
	const events = [];
	const recordSession = (sessionId, event) => events.push({ sessionId, ...event });
	const llm = createLlm({
		'p1/m1': [[errorChunk('SERVER', 'down')], [errorChunk('SERVER', 'down')]],
		'p2/m2': [okAttempt('ok')],
	});
	const config = makeConfig(
		[
			target('p1', 'm1', { maxRetries: 1, initialDelayMs: 10, maxDelayMs: 10, jitterRatio: 0 }),
			target('p2', 'm2'),
		],
		{ breaker: { failureThreshold: 2, lockMs: 1000 } },
	);
	const { adapter } = makeAdapter(config, llm, { runtimeRef, recordSession });

	await collect(adapter.stream({ ...streamOptions, sessionId: 's1' }));

	assert.ok(events.some((event) => event.kind === 'retry' && event.target === 'p1/m1'));
	assert.ok(events.some((event) => event.kind === 'lock' && event.lockedUntil === 2000));
	assert.ok(events.some((event) => event.kind === 'fallback' && event.target === 'p1/m1'));
	assert.equal(events[0].sessionId, 's1');
	assert.ok(published.length >= 2);
	const latest = published.at(-1);
	assert.equal(latest.targets.length, 2);
	assert.equal(latest.targets[0].key, 'p1\u0000m1');
	assert.equal(latest.targets[0].state, 'open');
	assert.equal(latest.targets[0].failures, 2);
	assert.equal(latest.targets[0].locks, 1);
});

test('网关包装的上游 400 在链上第二个 target 成功（线上 2026-11-24 复现）', async () => {
	// target 1 返回网关的包装 400（pi-ai 判 INVALID_REQUEST），同一 payload 在
	// target 2 上 200。以前的分类把它当 stop，直接抛原始错误、链等于不存在。
	const llm = createLlm({
		'p1/m1': [
			[
				errorChunk(
					'INVALID_REQUEST',
					'400: {"message":"[code=upstream_error] The request could not be completed.","type":"upstream_error","code":"upstream_error"}',
				),
			],
		],
		'p2/m2': [okAttempt('recovered')],
	});
	const { adapter, warnings } = makeAdapter(
		makeConfig([target('p1', 'm1', { maxRetries: 0 }), target('p2', 'm2')]),
		llm,
	);

	const chunks = await collect(adapter.stream(streamOptions));

	assert.equal(chunks.at(-1).reason.kind, 'stop');
	assert.equal(llm.calls.length, 2);
	assert.equal(llm.calls[1].provider, 'p2');
	assert.ok(warnings.some((line) => line.includes('target p1/m1 exhausted (INVALID_REQUEST)')));
	// target 1 的失败要记进熔断（它确实是 target 级故障）；target 2 成功后自己的 entry 归零。
	assert.equal(adapter.breaker.state('p1\u0000m1'), 'closed');
	assert.equal(adapter.breaker.snapshot().entries['p1\u0000m1'].failures, 1);
});

test('真正的请求错误仍然直通：包装识别不会把非法 payload 变成重试', async () => {
	const llm = createLlm({
		'p1/m1': [[errorChunk('INVALID_REQUEST', '400: {"error":{"message":"tools[0]: missing field `type`"}}')]],
		'p2/m2': [okAttempt('should not be used')],
	});
	const { adapter } = makeAdapter(
		makeConfig([target('p1', 'm1', { maxRetries: 3 }), target('p2', 'm2')]),
		llm,
	);

	const { error } = await collectSettled(adapter.stream(streamOptions));

	assert.equal(error.code, 'INVALID_REQUEST');
	assert.equal(llm.calls.length, 1);
});

test('链路主动停下（请求真坏）时写一条可追的会话记录', async () => {
	const records = [];
	const llm = createLlm({
		'p1/m1': [[errorChunk('INVALID_REQUEST', 'tools[0]: missing field `type`')]],
		'p2/m2': [okAttempt('should not be used')],
	});
	const { adapter } = makeAdapter(
		makeConfig([target('p1', 'm1', { maxRetries: 3 }), target('p2', 'm2')]),
		llm,
		{ recordSession: (sessionId, event) => records.push(event) },
	);

	await collectSettled(adapter.stream({ ...streamOptions, sessionId: 's1' }));

	assert.deepEqual(records, [
		{ kind: 'stop', target: 'p1/m1', code: 'INVALID_REQUEST', reason: 'request-invalid' },
	]);
});
