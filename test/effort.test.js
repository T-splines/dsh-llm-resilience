import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	CANONICAL_EFFORTS,
	chooseEffort,
	effortRank,
	isAutoEffort,
	mergeEfforts,
	parseSupportedEfforts,
	planTargetEffort,
} from '../lib/effort.js';

const efforts = (...ids) => ids.map((id) => ({ id, name: id }));

test('标准档位与 dsh-llm-pi-ai 的升级顺序一致', () => {
	assert.deepEqual(
		CANONICAL_EFFORTS.map((effort) => effort.id),
		['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
	);
	assert.deepEqual(
		CANONICAL_EFFORTS.map((effort) => effort.rank),
		[0, 10, 25, 50, 75, 90, 100],
	);
});

test('常见别名落在同一把 0–100 尺子上；认不出就返回 undefined', () => {
	assert.equal(effortRank('none'), 0);
	assert.equal(effortRank('OFF'), 0);
	assert.equal(effortRank('extra-high'), 90);
	assert.equal(effortRank('maximum'), 100);
	assert.equal(effortRank('50'), 50);
	assert.equal(effortRank('custom-level'), undefined);
	assert.equal(effortRank(''), undefined);
});

test('auto 判定兼容空串与大小写', () => {
	assert.equal(isAutoEffort(undefined), true);
	assert.equal(isAutoEffort(''), true);
	assert.equal(isAutoEffort(' AUTO '), true);
	assert.equal(isAutoEffort('high'), false);
});

test('合成档位：标准档位在前，自定义档位追加且去重', () => {
	const merged = mergeEfforts(
		[
			{ id: 'high', name: 'High' },
			{ id: 'turbo', name: 'Turbo', description: 'provider specific' },
		],
		[{ id: 'turbo' }, { id: 'custom' }],
	);
	assert.deepEqual(
		merged.map((effort) => effort.id),
		['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'turbo', 'custom'],
	);
	assert.deepEqual(merged[7], { id: 'turbo', name: 'Turbo', description: 'provider specific' });
});

test('选择档位：精确命中优先；就近映射等距时取更高', () => {
	assert.equal(chooseEffort('high', efforts('low', 'high')), 'high');
	assert.equal(chooseEffort('max', efforts('low', 'high')), 'high');
	assert.equal(chooseEffort('off', efforts('low', 'high')), 'low');
	// medium=50 到 low=25 / high=75 等距；用户要的是「更强」时不应悄悄降级。
	assert.equal(chooseEffort('medium', efforts('low', 'high')), 'high');
});

test('选择档位：未知请求优先最高档，没有可排序候选才用默认值', () => {
	assert.equal(
		chooseEffort('custom-level', efforts('low', 'high'), { defaultEffort: 'low' }),
		'high',
	);
	assert.equal(chooseEffort('custom-level', efforts('low', 'high')), 'high');
	assert.equal(
		chooseEffort('custom-level', efforts('alpha', 'beta'), { defaultEffort: 'beta' }),
		'beta',
	);
	assert.equal(chooseEffort('custom-level', efforts('alpha', 'beta')), 'alpha');
	assert.equal(chooseEffort('high', []), undefined);
});

test('planTargetEffort：auto 跟随会话；固定值覆盖会话；无能力时省略', () => {
	const info = {
		reasoning: { efforts: efforts('low', 'high'), defaultEffort: 'low' },
	};
	assert.deepEqual(planTargetEffort({ requested: undefined, override: 'auto', info }), {
		desired: undefined,
		effort: undefined,
		reason: 'auto',
	});
	assert.deepEqual(planTargetEffort({ requested: 'AUTO', override: 'auto', info }), {
		desired: undefined,
		effort: undefined,
		reason: 'auto',
	});
	assert.deepEqual(planTargetEffort({ requested: 'max', override: 'auto', info }), {
		desired: 'max',
		effort: 'high',
		reason: 'mapped',
	});
	assert.deepEqual(planTargetEffort({ requested: 'max', override: 'low', info }), {
		desired: 'low',
		effort: 'low',
		reason: 'exact',
	});
	assert.deepEqual(planTargetEffort({ requested: 'max', override: 'auto', info: undefined }), {
		desired: 'max',
		effort: undefined,
		reason: 'unsupported',
	});
});

test('parseSupportedEfforts：从报错原文认出标准档位，不把普通词当档位', () => {
	assert.deepEqual(
		parseSupportedEfforts('unsupported effort "max"; supported: low, medium, high').map(
			(effort) => effort.id,
		),
		['low', 'medium', 'high', 'max'],
	);
	assert.deepEqual(parseSupportedEfforts('the default model is offline'), []);
	assert.deepEqual(
	parseSupportedEfforts('xhigh is required, not high').map((effort) => effort.id),
	['high', 'xhigh'],
);
});