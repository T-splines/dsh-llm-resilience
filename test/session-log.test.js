import assert from 'node:assert/strict';
import { test } from 'node:test';

import { RECORD_TYPE, createSessionRecorder } from '../lib/session-log.js';

test('记录类型固定为 plugin:llm-fallback，并自动补 at', () => {
	const appended = [];
	const record = createSessionRecorder(
		{ get: () => ({ id: 's1' }) },
		undefined,
		(session, type, data) => appended.push({ session, type, data }),
	);
	record('s1', { kind: 'retry', attempt: 2 });
	assert.equal(appended.length, 1);
	assert.equal(appended[0].type, RECORD_TYPE);
	assert.equal(appended[0].type, 'plugin:llm-fallback');
	assert.equal(appended[0].data.kind, 'retry');
	assert.equal(typeof appended[0].data.at, 'number');
});

test('缺失 sessionId / session / sessions 服务时静默跳过', () => {
	let calls = 0;
	const append = () => {
		calls += 1;
	};
	createSessionRecorder(undefined, undefined, append)(undefined, { kind: 'retry' });
	createSessionRecorder({ get: () => undefined }, undefined, append)('unknown', { kind: 'retry' });
	createSessionRecorder({ get: () => { throw new Error('boom'); } }, undefined, append)('s1', { kind: 'retry' });
	assert.equal(calls, 0);
});

test('append 失败只告警一次，不打断主流', () => {
	const warnings = [];
	let calls = 0;
	const record = createSessionRecorder(
		{ get: () => ({ id: 's1' }) },
		{ warn: (message) => warnings.push(message) },
		() => {
			calls += 1;
			throw new Error('session closed');
		},
	);
	assert.doesNotThrow(() => record('s1', { kind: 'retry' }));
	assert.doesNotThrow(() => record('s1', { kind: 'lock' }));
	assert.equal(calls, 2);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /cannot append session record/);
});
