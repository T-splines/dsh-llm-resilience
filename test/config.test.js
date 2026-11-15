import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Config, plainConfig, resolvePluginConfig } from '../lib/config.js';
import { SETTINGS_ENTRY, apply } from '../lib/index.js';

function fakeCtx() {
	const logs = [];
	const registrations = [];
	return {
		logs,
		registrations,
		logger: {
			info: (message) => logs.push(message),
			warn: (message) => logs.push(message),
		},
		llm: {
			registerAdapter: (providers, adapter) => {
				registrations.push({ providers, adapter });
				return () => {};
			},
		},
	};
}

test('Config 的每个根字段都是活单元格（0.2.0 设置平面准入条件）', () => {
	const raw = Config({});
	assert.deepEqual(Object.keys(raw).sort(), [
		'breaker',
		'codeActions',
		'enabled',
		'limits',
		'route',
		'runtime',
		'targets',
		'toolCalls',
	]);
});

test('默认配置：dormant、Go 友好的重试默认值、探活默认值', () => {
	const resolved = resolvePluginConfig({});
	assert.equal(resolved.enabled, true);
	assert.equal(resolved.route, 'fallback');
	assert.deepEqual(resolved.targets, []);
	assert.equal(resolved.breaker.failureThreshold, 5);
	assert.equal(resolved.breaker.lockMs, 3600000);
	assert.equal(resolved.breaker.probe.enabled, true);
	assert.equal(resolved.breaker.probe.background, false);
	assert.equal(resolved.breaker.probe.maxTokens, 1);
	assert.equal(resolved.limits.maxTotalMs, 600000);
	assert.equal(resolved.limits.maxAttempts, 50);
	assert.deepEqual(resolved.runtime, { version: 0, updatedAt: 0, targets: [] });
	assert.equal(resolved.toolCalls.retryMalformed, true);
	assert.deepEqual(Object.keys(resolved.toolCalls), ['retryMalformed']);
	assert.deepEqual(resolved.codeActions, {});

	const plain = plainConfig(Config({}));
	assert.equal(plain.enabled, true);
	assert.equal(plain.route, 'fallback');
	assert.deepEqual(plain.targets, []);
});

test('target 缺省值会被补齐，且每个 target 独立', () => {
	const resolved = resolvePluginConfig({
		targets: [
			{ provider: 'opendesign', model: 'deepseek-v4.1-flash-eco' },
			{ provider: 'deepseek', model: 'deepseek-flash', maxRetries: 10, multiplier: 1.5 },
		],
	});

	assert.equal(resolved.targets[0].enabled, true);
	assert.equal(resolved.targets[0].maxRetries, 5);
	assert.equal(resolved.targets[0].initialDelayMs, 1500);
	assert.equal(resolved.targets[0].multiplier, 2);
	assert.equal(resolved.targets[0].maxDelayMs, 20000);
	assert.equal(resolved.targets[0].jitterRatio, 0.3);
	assert.equal(resolved.targets[1].maxRetries, 10);
	assert.equal(resolved.targets[1].multiplier, 1.5);
});

test('apply：空 targets 保持 dormant，但 route 仍然注册（设置页可实时加链）', () => {
	const ctx = fakeCtx();
	assert.doesNotThrow(() => apply(ctx, {}));
	assert.ok(ctx.logs.some((line) => /dormant/.test(line)));
	assert.equal(ctx.registrations.length, 1);
	assert.deepEqual(ctx.registrations[0].providers, ['fallback']);
});

test('apply：配置了 targets 时注册适配器并报告 target 数量', () => {
	const ctx = fakeCtx();
	assert.doesNotThrow(() =>
		apply(ctx, { targets: [{ provider: 'opendesign', model: 'deepseek-v4.1-flash-eco' }] }),
	);
	assert.equal(ctx.registrations.length, 1);
	assert.ok(ctx.logs.some((line) => /1 enabled target/.test(line)));
});

test('apply：非法链在加载期报错，且不注册适配器', () => {
	const ctx = fakeCtx();
	assert.throws(
		() => apply(ctx, { targets: [{ provider: 'fallback', model: 'x' }] }),
		/invalid configuration/,
	);
	assert.throws(
		() => apply(ctx, { targets: [{ provider: 'p', model: 'm' }], codeActions: { SERVER: 'nope' } }),
		/invalid configuration/,
	);
	assert.equal(ctx.registrations.length, 0);
});

test('设置页 entry id 与 patch 一致', () => {
	assert.equal(SETTINGS_ENTRY, 'llm-fallback');
});
