import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { nominalSchedule } from '../lib/policy.js';

let loaded;
globalThis.window = {
	__ModuleLoader__: {
		load({ id, factory }) {
			loaded = {
				id,
				exports: factory((name) => {
					if (name === 'react') return { useState: () => [undefined, () => {}], useEffect: () => {} };
					if (name === 'react/jsx-runtime') {
						return { jsx: () => null, jsxs: () => null, Fragment: 'Fragment' };
					}
					throw new Error(`unexpected require: ${name}`);
				}),
			};
		},
	},
};

await import('../lib/client.js');

const helpers = loaded.exports.__test;
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('客户端注册在 llm-fallback 命名空间，并暴露 apply/inject', () => {
	assert.equal(loaded.id, '@magic6/dsh-llm-resilience');
	assert.equal(typeof loaded.exports.apply, 'function');
	assert.ok(loaded.exports.inject.includes('locale'));
	assert.ok(loaded.exports.inject.includes('configForms'));
	assert.ok(loaded.exports.inject.includes('slots'));
	assert.ok(loaded.exports.inject.includes('remote.settings'));
});

test('package manifest 声明 web client 与 entry id', () => {
	const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
	assert.equal(pkg.dsh.client.platform, 'web');
	assert.ok(pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-settings'));
	assert.equal(pkg.exports['./client'], './lib/client.js');
	assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');

	const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8');
	assert.match(patch, /- id: llm-fallback/);

	const source = readFileSync(join(root, 'lib/client.js'), 'utf8');
	assert.match(source, /plugins\.bundle\.config/);
	assert.match(source, /key: PACKAGE_NAME/);
	assert.doesNotMatch(source, /settings\.models\.footer/);
	assert.match(source, /configForms\.get\('llm-fallback'\)/);
});

test('重试计划与 host 的 nominalSchedule 完全一致（2 倍与 1.5 倍）', () => {
	for (const multiplier of [2, 1.5]) {
		const target = {
			maxRetries: 10,
			initialDelayMs: 1500,
			multiplier,
			maxDelayMs: 20000,
			jitterRatio: 0.3,
		};
		const rows = helpers.retryPlanRows(target).rows;
		const host = nominalSchedule(target);
		assert.equal(rows.length, 10);
		assert.deepEqual(
			rows.map((row) => row.nominalMs),
			host.map((row) => row.nominalDelayMs),
		);
		assert.ok(rows.every((row) => row.highMs >= row.nominalMs));
		assert.ok(rows.every((row) => row.highMs <= 20000));
	}
});

test('抖动区间四舍五入并遵守上限', () => {
	const plan = helpers.retryPlanRows({
		maxRetries: 2,
		initialDelayMs: 1500,
		multiplier: 2,
		maxDelayMs: 1600,
		jitterRatio: 0.5,
	});
	assert.deepEqual(plan.rows[0], { attempt: 1, nominalMs: 1500, lowMs: 750, highMs: 1600 });
	assert.deepEqual(plan.rows[1], { attempt: 2, nominalMs: 1600, lowMs: 800, highMs: 1600 });

	const noRetry = helpers.retryPlanRows({ maxRetries: 0 });
	assert.deepEqual(noRetry.rows, []);
	assert.equal(noRetry.totalMs, 0);
});

test('预览行数有上限，避免荒谬的重试次数卡住页面', () => {
	const plan = helpers.retryPlanRows({ maxRetries: 500, initialDelayMs: 100 });
	assert.equal(plan.rows.length, 50);
	assert.equal(plan.retries, 500);
	assert.equal(plan.truncated, true);
});

test('时长格式保留 0.1 秒/分钟', () => {
	assert.equal(helpers.formatMs(500), '500ms');
	assert.equal(helpers.formatMs(1050), '1.1s');
	assert.equal(helpers.formatMs(1500), '1.5s');
	assert.equal(helpers.formatMs(20000), '20s');
	assert.equal(helpers.formatMs(3600000), '60min');
});

test('运行状态新鲜度格式', () => {
	assert.equal(helpers.formatAge(400), '<1s');
	assert.equal(helpers.formatAge(3200), '3s');
	assert.equal(helpers.formatAge(125000), '2min');
	assert.equal(helpers.formatAge(-1), '—');
});

test('配置 → 草稿 → ops 往返不丢字段', () => {
	const value = {
		enabled: false,
		targets: [
			{
				enabled: false,
				provider: 'p',
				model: 'm',
				label: '备用',
				maxRetries: 7,
				initialDelayMs: 1500,
				multiplier: 1.5,
				maxDelayMs: 20000,
				jitterRatio: 0.3,
			},
		],
		breaker: {
			failureThreshold: 3,
			lockMs: 3600000,
			probe: { enabled: false, background: true, timeoutMs: 9000, maxTokens: 2, prompt: 'pong' },
			stateFile: '/tmp/fallback-state.json',
		},
		limits: { maxTotalMs: 120000, maxAttempts: 12 },
		toolCalls: { retryMalformed: false },
	};
	const draft = helpers.configDraft(value);
	assert.equal(draft.lockMinutes, '60');
	assert.equal(draft.targets[0].maxRetries, '7');
	assert.equal(draft.targets[0].enabled, false);
	assert.equal(draft.probeBackground, true);
	assert.equal(draft.maxTotalMs, '120000');
	assert.equal(draft.maxAttempts, '12');

	const ops = Object.fromEntries(
		helpers.buildOps(draft).map((op) => [op.path.join('.'), op.value]),
	);
	assert.equal(ops.enabled, false);
	assert.deepEqual(ops.targets[0], value.targets[0]);
	assert.equal(ops.breaker.lockMs, 3600000);
	assert.deepEqual(ops.breaker.probe, value.breaker.probe);
	assert.equal(ops.breaker.stateFile, '/tmp/fallback-state.json');
	assert.deepEqual(ops.limits, value.limits);
	assert.deepEqual(ops.toolCalls, { retryMalformed: false });
});

test('空配置解析为 schema 默认值，不伪造额外 target', () => {
	const draft = helpers.configDraft({});
	assert.deepEqual(draft.targets, []);
	assert.equal(draft.enabled, true);
	assert.equal(draft.failureThreshold, '5');
	assert.equal(draft.lockMinutes, '60');
	assert.equal(draft.probeEnabled, true);
	assert.equal(draft.probeBackground, false);
	assert.equal(draft.probePrompt, 'ping');
	assert.equal(draft.maxTotalMs, '600000');
	assert.equal(draft.maxAttempts, '50');
	assert.equal(draft.stateFile, '$DSH_HOME/storages/llm-resilience/state.json');
	assert.equal(draft.retryMalformed, true);
});

test('校验：启用条目的 provider/model/数值与熔断字段', () => {
	const base = helpers.configDraft({ targets: [{ provider: 'p', model: 'm' }] });
	assert.deepEqual(helpers.validateDraft(base, 'fallback'), []);

	const disabled = helpers.configDraft({
		targets: [{ provider: '', model: '', enabled: false }],
	});
	assert.deepEqual(helpers.validateDraft(disabled, 'fallback'), []);

	const empty = helpers.configDraft({ targets: [{ provider: '', model: '' }] });
	assert.deepEqual(
		helpers.validateDraft(empty, 'fallback').map((entry) => entry.key),
		['errProvider', 'errModel'],
	);

	const duplicate = helpers.configDraft({
		targets: [
			{ provider: 'p', model: 'm' },
			{ provider: 'p', model: 'm' },
		],
	});
	assert.ok(helpers.validateDraft(duplicate, 'fallback').some((entry) => entry.key === 'errDuplicate'));

	const self = helpers.configDraft({ targets: [{ provider: 'fallback', model: 'm' }] });
	assert.ok(helpers.validateDraft(self, 'fallback').some((entry) => entry.key === 'errSelf'));

	const badNumbers = helpers.configDraft({
		targets: [
			{
				provider: 'p',
				model: 'm',
				maxRetries: '1.5',
				initialDelayMs: '1500',
				multiplier: '1',
				maxDelayMs: '100',
				jitterRatio: '2',
			},
		],
		breaker: {
			failureThreshold: 0,
			lockMs: 3600000,
			probe: { enabled: true, timeoutMs: 0, maxTokens: 0, prompt: ' ' },
			stateFile: '',
		},
		limits: { maxTotalMs: -1, maxAttempts: '1.5' },
	});
	badNumbers.lockMinutes = '0';
	const keys = helpers.validateDraft(badNumbers, 'fallback').map((entry) => entry.key);
	for (const key of [
		'errMaxRetries',
		'errMultiplier',
		'errMaxDelay',
		'errJitter',
		'errFailureThreshold',
		'errLock',
		'errProbeTimeout',
		'errProbeMaxTokens',
		'errProbePrompt',
		'errMaxTotalMs',
		'errMaxAttempts',
		'errStateFile',
	]) {
		assert.ok(keys.includes(key), `missing ${key}`);
	}
});

test('校验：provider/model 必须存在于会话模型目录', () => {
	const catalog = {
		groups: [
			{ id: 'opendesign', models: [{ id: 'deepseek-v4.1-flash' }, { id: 'deepseek-v4.1-flash-eco' }] },
			{ id: 'deepseek-official', models: [{ id: 'deepseek-flash' }] },
		],
	};
	const good = helpers.configDraft({
		targets: [
			{ provider: 'opendesign', model: 'deepseek-v4.1-flash-eco' },
			{ provider: 'deepseek-official', model: 'deepseek-flash' },
		],
	});
	assert.deepEqual(helpers.validateDraft(good, 'fallback', catalog), []);

	const unknownProvider = helpers.configDraft({
		targets: [{ provider: 'made-up', model: 'deepseek-flash' }],
	});
	assert.ok(
		helpers.validateDraft(unknownProvider, 'fallback', catalog).some(
			(entry) => entry.key === 'errProviderUnknown',
		),
	);

	const unknownModel = helpers.configDraft({
		targets: [{ provider: 'opendesign', model: 'not-a-model' }],
	});
	assert.ok(
		helpers.validateDraft(unknownModel, 'fallback', catalog).some(
			(entry) => entry.key === 'errModelUnknown',
		),
	);

	// 目录不可用时不做存在性判断，交给卡片的 catalogBlocked 挡住保存。
	assert.deepEqual(helpers.validateDraft(unknownModel, 'fallback', null), []);
});

test('目标顺序编辑只移动一格', () => {
	const targets = helpers.configDraft({
		targets: [
			{ provider: 'p1', model: 'm1' },
			{ provider: 'p2', model: 'm2' },
			{ provider: 'p3', model: 'm3' },
		],
	}).targets;
	assert.deepEqual(
		helpers.moveIn(targets, 1, -1).map((target) => target.provider),
		['p2', 'p1', 'p3'],
	);
	assert.deepEqual(
		helpers.moveIn(targets, 1, 1).map((target) => target.provider),
		['p1', 'p3', 'p2'],
	);
});
