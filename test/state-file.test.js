import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { readStateFileSync, writeStateFileMerged } from '../lib/state-file.js';

function tempDir() {
	return mkdtempSync(join(tmpdir(), 'dsh-llm-resilience-state-'));
}

function entry({ failures = 1, lockedUntil = 1000, locks = 1, openedAt = 900 } = {}) {
	return { failures, openedAt, lockedUntil, probing: false, locks };
}

test('并发写入不同 key：读-合并-写不会互相覆盖', async () => {
	const dir = tempDir();
	const path = join(dir, 'state.json');
	await Promise.all([
		writeStateFileMerged(path, { version: 1, entries: { a: entry() }, cleared: {} }),
		writeStateFileMerged(path, { version: 1, entries: { b: entry({ lockedUntil: 2000 }) }, cleared: {} }),
	]);
	const saved = JSON.parse(readFileSync(path, 'utf8'));
	assert.deepEqual(Object.keys(saved.entries).sort(), ['a', 'b']);
	assert.equal(saved.entries.b.lockedUntil, 2000);
	rmSync(dir, { recursive: true, force: true });
});

test('同一 key 冲突：锁更晚的胜出；本进程没见过的 key 保留', async () => {
	const dir = tempDir();
	const path = join(dir, 'state.json');
	await writeStateFileMerged(path, {
		version: 1,
		entries: { keep: entry(), k: entry({ lockedUntil: 5000, failures: 6, locks: 2 }) },
		cleared: {},
	});
	await writeStateFileMerged(path, {
		version: 1,
		entries: { k: entry({ lockedUntil: 3000, failures: 2, locks: 1 }) },
		cleared: {},
	});
	const saved = JSON.parse(readFileSync(path, 'utf8'));
	assert.equal(saved.entries.k.lockedUntil, 5000, '更早的锁不能覆盖更晚的锁');
	assert.equal(saved.entries.k.failures, 6);
	assert.ok(saved.entries.keep !== undefined, '未出现在 incoming 里的 key 保留');
	rmSync(dir, { recursive: true, force: true });
});

test('跨进程成功清除：tombstone 删除旧锁，但保留清除之后新开的锁', async () => {
	const dir = tempDir();
	const path = join(dir, 'state.json');
	await writeStateFileMerged(path, {
		version: 1,
		entries: { k: entry({ openedAt: 1000, lockedUntil: 9000 }) },
		cleared: {},
	});

	// 另一个进程在 2000 成功过，它的快照里只有 tombstone。
	await writeStateFileMerged(path, { version: 1, entries: {}, cleared: { k: 2000 } });
	let saved = JSON.parse(readFileSync(path, 'utf8'));
	assert.equal(saved.entries.k, undefined, '成功之后的合并必须清掉旧锁');
	assert.equal(saved.cleared.k, 2000);

	// 之后 3000 又失败开锁：不能被更早的 tombstone 误删。
	await writeStateFileMerged(path, {
		version: 1,
		entries: { k: entry({ openedAt: 3000, lockedUntil: 12000 }) },
		cleared: {},
	});
	saved = JSON.parse(readFileSync(path, 'utf8'));
	assert.equal(saved.entries.k?.lockedUntil, 12000);
	rmSync(dir, { recursive: true, force: true });
});

test('锁文件已存在且未过期：本次跳过，不写状态文件', async () => {
	const dir = tempDir();
	const path = join(dir, 'state.json');
	writeFileSync(`${path}.lock`, '999\n0\n', 'utf8');
	const result = await writeStateFileMerged(
		path,
		{ version: 1, entries: { a: entry() }, cleared: {} },
		{ lockTimeoutMs: 60, staleLockMs: 60000 },
	);
	assert.equal(result, undefined);
	assert.throws(() => readFileSync(path, 'utf8'), /ENOENT/);
	rmSync(dir, { recursive: true, force: true });
});

test('崩溃残留的过期锁被清理，写入继续', async () => {
	const dir = tempDir();
	const path = join(dir, 'state.json');
	const lockPath = `${path}.lock`;
	writeFileSync(lockPath, '999\n0\n', 'utf8');
	const old = new Date(Date.now() - 60000);
	utimesSync(lockPath, old, old);
	const result = await writeStateFileMerged(
		path,
		{ version: 1, entries: { a: entry() }, cleared: {} },
		{ lockTimeoutMs: 200, staleLockMs: 5000 },
	);
	assert.ok(result !== undefined);
	const saved = JSON.parse(readFileSync(path, 'utf8'));
	assert.ok(saved.entries.a !== undefined);
	assert.throws(() => readFileSync(lockPath, 'utf8'), /ENOENT/, '写完必须释放锁');
	rmSync(dir, { recursive: true, force: true });
});

test('损坏的状态文件按空处理，不阻塞新锁写入', async () => {
	const dir = tempDir();
	const path = join(dir, 'state.json');
	writeFileSync(path, '{not json', 'utf8');
	const warnings = [];
	await writeStateFileMerged(
		path,
		{ version: 1, entries: { a: entry() }, cleared: {} },
		{ logger: { warn: (message) => warnings.push(message) } },
	);
	const saved = JSON.parse(readFileSync(path, 'utf8'));
	assert.ok(saved.entries.a !== undefined);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /cannot read breaker state/);
	rmSync(dir, { recursive: true, force: true });
});

test('readStateFileSync：缺失返回 undefined，损坏返回 undefined 并告警一次', () => {
	const dir = tempDir();
	const missing = join(dir, 'missing.json');
	assert.equal(readStateFileSync(missing), undefined);

	const broken = join(dir, 'broken.json');
	writeFileSync(broken, 'nope', 'utf8');
	const warnings = [];
	assert.equal(readStateFileSync(broken, { warn: (message) => warnings.push(message) }), undefined);
	assert.equal(warnings.length, 1);
	rmSync(dir, { recursive: true, force: true });
});
