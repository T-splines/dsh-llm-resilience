#!/usr/bin/env node
/**
 * 从 dsh 会话日志（session.v4.jsonl.zstd）里抽取所有 LLM 层错误的时间点与信息。
 *
 * 会话文件动辄几十 MB、上万条事件，不要直接读；本脚本流式解压 + 逐行解析，
 * 只保留「LLM 请求失败」相关的事件：
 *
 *   - `assistant/attempt` 的 finish.reason.kind === 'error'   ← 适配器/上游给的 failure
 *   - `turn/end` 的 reason.kind === 'error'                   ← 本轮最终对用户可见的错误
 *   - `llm/retry` / `llm/retry-started`                       ← 宿主整步重放
 *   - `plugin:llm-fallback`                                   ← 重试/熔断/fallback/探活
 *
 * 用法：
 *   node scripts/session-llm-errors.mjs <session-id|session-dir|file.jsonl.zstd>
 *   node scripts/session-llm-errors.mjs <会话> --json        # 机器可读
 *   node scripts/session-llm-errors.mjs <会话> --since 22:00 # 只看该时刻之后（本地时间）
 *   node scripts/session-llm-errors.mjs <会话> --verbose     # 打印完整错误信息
 *
 * 会话目录默认在 $DSH_HOME/sessions 下（按 cwd 分桶），脚本会自己找。
 */

import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { createZstdDecompress } from 'node:zlib';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh');

function usage(code = 2) {
	process.stderr.write(
		'usage: session-llm-errors.mjs <session-id|session-dir|session.v4.jsonl.zstd> [--json] [--verbose] [--since HH:MM[;HH:MM]]\n',
	);
	process.exit(code);
}

/** 把「会话 id / 会话目录 / 压缩文件」解析成真实文件路径。 */
function resolveSessionFile(arg) {
	if (arg === undefined) usage();
	if (existsSync(arg) && statSync(arg).isFile() && arg.endsWith('.zstd')) return arg;
	const dir = existsSync(arg) && statSync(arg).isDirectory() ? arg : undefined;
	if (dir !== undefined) {
		const file = join(dir, 'session.v4.jsonl.zstd');
		if (existsSync(file)) return file;
		throw new Error(`${dir} 下没有 session.v4.jsonl.zstd`);
	}
	// 会话目录名有两种历史格式：`<uuid>` 与 `session-<uuid>`，两种都试。
	const ids = arg.startsWith('session-') ? [arg, arg.slice('session-'.length)] : [arg, `session-${arg}`];
	const root = join(DSH_HOME, 'sessions');
	const buckets = existsSync(root) ? readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()) : [];
	for (const id of ids) {
		for (const bucket of buckets) {
			const candidate = join(root, bucket.name, id, 'session.v4.jsonl.zstd');
			if (existsSync(candidate)) return candidate;
		}
	}
	throw new Error(`找不到会话 ${arg}（在 ${root} 下按 <bucket>/<session>/session.v4.jsonl.zstd 搜索）`);
}

function parseArgs(argv) {
	const options = { json: false, verbose: false, since: undefined, target: undefined };
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === '--json') options.json = true;
		else if (arg === '--verbose' || arg === '-v') options.verbose = true;
		else if (arg === '--since') options.since = argv[++index];
		else if (arg === '--help' || arg === '-h') usage(0);
		else if (options.target === undefined) options.target = arg;
		else usage();
	}
	return options;
}

/** 逐行产出解压后的 JSON 事件；zstd 优先用 node:zlib，旧 Node 回落到 zstd CLI。 */
async function* readEvents(file) {
	let stream;
	if (typeof createZstdDecompress === 'function') {
		stream = createReadStream(file).pipe(createZstdDecompress());
	} else {
		const child = spawn('zstd', ['-dc', file], { stdio: ['ignore', 'pipe', 'inherit'] });
		stream = child.stdout;
	}
	const lines = createInterface({ input: stream, crlfDelay: Infinity });
	for await (const line of lines) {
		if (line.length === 0) continue;
		try {
			yield JSON.parse(line);
		} catch {
			// 压缩流尾部截断（进程被杀）时会有一条不完整行：跳过，不中断。
		}
	}
}

const pad = (value, width) => String(value).padEnd(width);
const time = (ms) => new Date(ms).toLocaleString('sv-SE', { hour12: false });

function oneLine(text, max) {
	const flat = String(text ?? '')
		.replace(/\s+/g, ' ')
		.trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** 从任意事件里挑出 LLM failure；不是 LLM 错误返回 undefined。 */
function classify(event) {
	const data = event?.data ?? {};
	if (event.type === 'assistant/attempt') {
		const finish = (data.stream ?? [])
			.map((entry) => entry?.chunk)
			.filter((chunk) => chunk?.type === 'finish')
			.at(-1);
		if (finish?.reason?.kind !== 'error') return undefined;
		return {
			source: 'assistant/attempt',
			turn: data.turn,
			step: data.step,
			failure: finish.reason.failure,
		};
	}
	if (event.type === 'turn/end') {
		if (data.reason?.kind !== 'error') return undefined;
		return {
			source: 'turn/end',
			turn: data.turn,
			step: undefined,
			failure: data.reason.error,
		};
	}
	if (event.type === 'llm/retry') {
		return {
			source: 'llm/retry',
			turn: data.turn,
			step: data.step,
			failure: data.failure,
			extra: `retry ${data.retry}/${data.maxRetries ?? '?'} delay=${Math.round(data.delayMs ?? 0)}ms`,
		};
	}
	if (event.type === 'llm/retry-started') {
		return {
			source: 'llm/retry-started',
			turn: data.turn,
			step: data.step,
			failure: undefined,
			extra: `retry ${data.retry} replay started`,
		};
	}
	if (event.type === 'plugin:llm-fallback') {
		const kind = data.kind;
		if (kind === 'retry') {
			return {
				source: 'plugin:llm-fallback',
				turn: undefined,
				step: undefined,
				failure: { code: data.code, message: `target ${data.target} 第 ${data.attempt} 次重试（延迟 ${Math.round(data.delayMs)}ms）` },
				extra: `retry ${data.target}`,
			};
		}
		if (kind === 'fallback') {
			return {
				source: 'plugin:llm-fallback',
				turn: undefined,
				step: undefined,
				failure: { code: data.code, message: `target ${data.target} 放弃，切下一个 target` },
				extra: `fallback ${data.target}`,
			};
		}
		if (kind === 'lock') {
			return {
				source: 'plugin:llm-fallback',
				turn: undefined,
				step: undefined,
				failure: {
					code: data.code,
					message: `熔断锁定 ${data.target} 至 ${new Date(data.lockedUntil).toISOString()}`,
				},
				extra: `lock ${data.target}`,
			};
		}
		if (kind === 'probe') {
			return {
				source: 'plugin:llm-fallback',
				turn: undefined,
				step: undefined,
				failure: {
					code: data.code ?? null,
					message: `探活 ${data.target} ${data.phase}${data.code ? ` (${data.code})` : ''}`,
				},
				extra: `probe ${data.target}`,
			};
		}
		if (kind === 'deadline') {
			return {
				source: 'plugin:llm-fallback',
				turn: undefined,
				step: undefined,
				failure: { code: data.code ?? 'DEADLINE_EXCEEDED', message: `预算耗尽（${data.reason}），已发 ${data.attempts} 次` },
				extra: 'budget',
			};
		}
		return undefined;
	}
	return undefined;
}

function parseSince(value) {
	if (value === undefined) return undefined;
	const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
	if (match === null) return undefined;
	const now = new Date();
	const at = new Date(now);
	at.setHours(Number(match[1]), Number(match[2]), 0, 0);
	if (at.getTime() > now.getTime()) at.setDate(at.getDate() - 1);
	return at.getTime();
}

const options = parseArgs(process.argv.slice(2));
const file = resolveSessionFile(options.target);
const since = parseSince(options.since);

const records = [];
let sessionMeta;
let total = 0;

for await (const event of readEvents(file)) {
	total += 1;
	if (event.type === 'session') {
		sessionMeta = event;
		continue;
	}
	if (since !== undefined && Number.isFinite(event.time) && event.time < since) continue;
	const record = classify(event);
	if (record === undefined) continue;
	records.push({
		time: Number.isFinite(event.time) ? event.time : undefined,
		seq: event.seq,
		...record,
		code: record.failure?.code ?? null,
		message: record.failure?.message ?? '',
	});
}

if (options.json) {
	process.stdout.write(`${JSON.stringify({ file, session: sessionMeta, events: records }, null, 2)}\n`);
	process.exit(0);
}

const out = [];
out.push(`会话: ${sessionMeta?.id ?? file}`);
out.push(`文件: ${file}  事件总数: ${total}  LLM 相关: ${records.length}`);
if (since !== undefined) out.push(`起点: ${time(since)} 之后`);

out.push('');
out.push(`${pad('时间', 20)} ${pad('turn/step', 10)} ${pad('来源', 20)} ${pad('code', 26)} 信息`);
out.push('-'.repeat(140));
for (const record of records) {
	const where = [record.turn === undefined ? '' : `t${record.turn}`, record.step === undefined ? '' : `s${record.step}`]
		.filter(Boolean)
		.join('/');
	const message = options.verbose ? record.message.replace(/\s+/g, ' ') : oneLine(record.message, 92);
	out.push(
		`${pad(record.time === undefined ? '?' : time(record.time), 20)} ${pad(where, 10)} ${pad(record.source, 20)} ${pad(
			record.code ?? '-',
			26,
		)} ${message}`,
	);
}

const byCode = new Map();
for (const record of records) {
	const key = record.code ?? '-';
	byCode.set(key, (byCode.get(key) ?? 0) + 1);
}
out.push('');
out.push(`按 code 统计: ${[...byCode].map(([code, count]) => `${code}×${count}`).join(', ')}`);

const turnEnds = records.filter((record) => record.source === 'turn/end');
if (turnEnds.length > 0) {
	out.push('');
	out.push('本轮最终错误（turn/end）:');
	for (const record of turnEnds) {
		out.push(`  t${record.turn} ${time(record.time)} [${record.code}] ${oneLine(record.message, 150)}`);
	}
}

process.stdout.write(`${out.join('\n')}\n`);
