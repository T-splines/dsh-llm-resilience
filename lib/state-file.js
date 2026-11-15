/**
 * 熔断状态的跨进程持久化。
 *
 * 多个 dsh 进程可能共享同一个 `stateFile`。裸的「临时文件 + rename」只能保证
 * 单进程不写坏文件，最后一个写入者仍会覆盖别人刚写下的锁。这里用 `stateFile.lock`
 * 做互斥，并在持锁期间 **读-合并-写**：同一个 key 取锁更晚/连败更多的条目胜出。
 *
 * 拿不到锁时跳过本次落盘并让调用方稍后重试；锁文件超过 `staleLockMs` 视为
 * 崩溃残留，直接清掉。写失败向上抛，由调用方记录。
 *
 * @module dsh-llm-resilience/state-file
 */

import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { mergeBreakerSnapshots } from './policy.js';

export function readStateFileSync(path, logger) {
	if (path === undefined) return undefined;
	try {
		return JSON.parse(readFileSync(path, 'utf8'));
	} catch (error) {
		if (error?.code !== 'ENOENT') {
			logger?.warn?.(
				`llm-resilience: cannot read breaker state ${path}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
		return undefined;
	}
}

async function readStateFile(path, logger) {
	try {
		return JSON.parse(await readFile(path, 'utf8'));
	} catch (error) {
		if (error?.code !== 'ENOENT') {
			logger?.warn?.(
				`llm-resilience: cannot read breaker state ${path}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
		return undefined;
	}
}

/**
 * 尝试创建锁文件。返回 `undefined` 表示在超时前没拿到；调用方应跳过本次写。
 */
async function acquireLock(lockPath, { timeoutMs, staleMs }, now) {
	const deadline = now() + timeoutMs;
	for (;;) {
		try {
			const handle = await open(lockPath, 'wx');
			await handle.writeFile(`${process.pid}\n${now()}\n`, 'utf8');
			return handle;
		} catch (error) {
			if (error?.code !== 'EEXIST') throw error;
			const info = await stat(lockPath).catch(() => undefined);
			if (info !== undefined && now() - info.mtimeMs > staleMs) {
				await unlink(lockPath).catch(() => {});
				continue;
			}
			if (now() >= deadline) return undefined;
			await new Promise((resolve) => setTimeout(resolve, 20 + Math.random() * 30));
		}
	}
}

/**
 * 持锁合并后落盘。
 *
 * @param path - 状态文件路径。
 * @param snapshot - 本进程当前的熔断快照。
 * @param options.logger - cordis logger。
 * @param options.now - 时钟，测试可注入。
 * @param options.lockTimeoutMs - 等锁上限；拿不到就跳过本次写。
 * @param options.staleLockMs - 锁文件多久没动视为崩溃残留。
 * @returns 合并后的快照；跳过时 `undefined`。
 */
export async function writeStateFileMerged(
	path,
	snapshot,
	{ logger, now = Date.now, lockTimeoutMs = 1000, staleLockMs = 5000 } = {},
) {
	await mkdir(dirname(path), { recursive: true });
	const lockPath = `${path}.lock`;
	const handle = await acquireLock(lockPath, { timeoutMs: lockTimeoutMs, staleMs: staleLockMs }, now);
	if (handle === undefined) return undefined;
	try {
		const base = await readStateFile(path, logger);
		const merged = mergeBreakerSnapshots(base, snapshot);
		const temporary = `${path}.tmp-${process.pid}-${now()}`;
		await writeFile(temporary, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
		await rename(temporary, path);
		return merged;
	} finally {
		await handle.close().catch(() => {});
		await unlink(lockPath).catch(() => {});
	}
}
