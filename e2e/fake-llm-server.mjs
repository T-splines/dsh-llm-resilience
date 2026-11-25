#!/usr/bin/env node
/**
 * 一个最小 OpenAI-compatible 假服务器，用来给这条回退链做**端到端**验证。
 *
 * 为什么需要它：单元测试用的是假的 adapter，只能证明「逻辑分支按预期走」；
 * 真实故障（网关把上游故障包成 `400 {"code":"upstream_error"}`、推理模型把
 * 探活预算全花在思考上）是**线上才暴露**的。要在上线前抓住它们，需要一个
 * 行为可控、但不碰真实 provider 的对端。
 *
 * 每个请求按 `SCRIPT` 顺序消费一条动作，用完重复最后一条：
 *
 *   ok            正常流式返回，内容是 `pong-from-<port>-<n>`（端口写进正文，
 *                 这样一眼能看出到底是哪个 target 答的）
 *   ok-slow       同上，但先停 200ms —— 用来测超时与首字节延迟
 *  500           瞬时故障 -> 应重试
 *  400upstream   线上那个 bug：400 但正文是 upstream_error -> 应 fallback
 *  400genuine    真·请求错误 -> 应 fail fast，不换 target
 *  empty         空内容 + finish_reason=length -> 探活无定论
 *  drop          发完 headers 就断流 -> TRANSPORT（内容已交付后失败）
 *
 * 环境变量：
 *   PORT           监听端口（必填）
 *   SCRIPT         逗号分隔的动作序列，默认 `ok`
 *   LOG_REQUESTS=1 把每次请求的形状打到 stdout（含 max_tokens，用来验证探活预算）
 *
 * 单独跑：
 *   SCRIPT=400upstream PORT=8799 node e2e/fake-llm-server.mjs
 */

import { createServer } from 'node:http';

const PORT = Number(process.env.PORT ?? 8799);
const script = (process.env.SCRIPT ?? 'ok').split(',');
const logRequests = process.env.LOG_REQUESTS === '1';
let served = 0;

function sse(res, frames) {
	res.writeHead(200, {
		'content-type': 'text/event-stream',
		'cache-control': 'no-cache',
		connection: 'keep-alive',
	});
	for (const frame of frames) res.write(`data: ${JSON.stringify(frame)}\n\n`);
	res.write('data: [DONE]\n\n');
	res.end();
}

function okFrames(id, text) {
	const at = Math.floor(Date.now() / 1000);
	const base = { id, object: 'chat.completion.chunk', created: at, model: 'fake-model' };
	return [
		{ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] },
		{ ...base, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] },
		{
			...base,
			choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
			usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
		},
	];
}

const server = createServer(async (req, res) => {
	if (!req.url?.includes('/chat/completions')) {
		res.writeHead(404, { 'content-type': 'application/json' }).end('{}');
		return;
	}

	let body = '';
	for await (const chunk of req) body += chunk;

	const action = script[Math.min(served, script.length - 1)];
	served += 1;

	if (logRequests) {
		let parsed = {};
		try {
			parsed = JSON.parse(body);
		} catch {
			/* 记形状用，解析失败不影响行为 */
		}
		const maxTokens = parsed.max_tokens ?? parsed.max_completion_tokens;
		const effort = parsed.reasoning_effort ?? parsed.reasoning?.effort ?? '-';
		console.log(
			`#${served} action=${action} model=${parsed.model} stream=${parsed.stream}` +
				` effort=${effort} max_tokens=${maxTokens} msgs=${(parsed.messages ?? []).length} tools=${(parsed.tools ?? []).length}`,
		);
	}

	switch (action) {
		case 'ok':
			sse(res, okFrames(`cmpl-${served}`, `pong-from-${PORT}-${served}`));
			return;

		case 'ok-slow':
			setTimeout(() => sse(res, okFrames(`cmpl-${served}`, `pong-from-${PORT}-${served}`)), 200);
			return;

		case '500':
			res
				.writeHead(500, { 'content-type': 'application/json' })
				.end(JSON.stringify({ error: { message: 'fake upstream 500', type: 'server_error' } }));
			return;

		case '400upstream':
			// 线上真实形状：HTTP 400，但正文说是上游故障。pi-ai 看到字面 400 会
			// 归成 INVALID_REQUEST，链若把它当「请求本身有错」就不会换 target。
			res
				.writeHead(400, { 'content-type': 'application/json' })
				.end(
					JSON.stringify({
						message: '[code=upstream_error] The request could not be completed.',
						type: 'upstream_error',
						code: 'upstream_error',
					}),
				);
			return;

		case '400genuine':
			res
				.writeHead(400, { 'content-type': 'application/json' })
				.end(JSON.stringify({ error: { message: 'invalid tool schema: missing type', type: 'invalid_request_error' } }));
			return;

		case 'empty':
			sse(res, [
				{
					id: `cmpl-${served}`,
					object: 'chat.completion.chunk',
					created: Math.floor(Date.now() / 1000),
					model: 'fake-model',
					choices: [{ index: 0, delta: {}, finish_reason: 'length' }],
				},
			]);
			return;

		case 'malformed-tools':
			// 线上实测过的形状：并行工具调用复用同一个 index，两个调用的 arguments
			// 被拼进一个块 -> MALFORMED_RESPONSE。默认重试名单含它时不换 target。
			sse(res, [
				{
					id: `cmpl-${served}`,
					object: 'chat.completion.chunk',
					created: Math.floor(Date.now() / 1000),
					model: 'fake-model',
					choices: [
						{
							index: 0,
							delta: {
								role: 'assistant',
								content: null,
								tool_calls: [
									{ index: 0, id: 'call_a', type: 'function', function: { name: 'read', arguments: '{"file":"a' } },
									{ index: 0, id: 'call_b', type: 'function', function: { name: 'read', arguments: '":{"file":"b"}' } },
								],
							},
							finish_reason: null,
						},
					],
				},
				{
					id: `cmpl-${served}`,
					object: 'chat.completion.chunk',
					created: Math.floor(Date.now() / 1000),
					model: 'fake-model',
					choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
				},
			]);
			return;

		case 'drop-mid-tool':
			// 工具调用吐到一半就断：block-start + 部分 arguments，没有 block-end。
			// 插件把 tool-call 压到 block-end 才交付，所以宿主**不该**看见这个半成品
			// —— 它应该透明地重试/回退。若缓冲坏了，宿主会拿到一个参数非法的调用。
			res.writeHead(200, { 'content-type': 'text/event-stream' });
			res.write(
				`data: ${JSON.stringify({
					id: `cmpl-${served}`,
					object: 'chat.completion.chunk',
					created: Math.floor(Date.now() / 1000),
					model: 'fake-model',
					choices: [
						{
							index: 0,
							delta: {
								role: 'assistant',
								tool_calls: [
									{ index: 0, id: 'call_x', type: 'function', function: { name: 'read', arguments: '{"file":"HALF' } },
								],
							},
							finish_reason: null,
						},
					],
				})}\n\n`,
			);
			await new Promise((resolve) => setTimeout(resolve, 150));
			res.destroy();
			return;

		case 'drop':
			res.writeHead(200, { 'content-type': 'text/event-stream' });
			res.write(
				`data: ${JSON.stringify({
					id: `cmpl-${served}`,
					object: 'chat.completion.chunk',
					created: Math.floor(Date.now() / 1000),
					model: 'fake-model',
					choices: [{ index: 0, delta: { role: 'assistant', content: 'PARTIAL-FROM-A' }, finish_reason: null }],
				})}\n\n`,
			);
			// 关键：**不发** `[DONE]`、也不发 `finish_reason`，直接断连接。
			// 这才是线上那种「流到一半上游断了」的形状。若在这里补发 [DONE]，
			// pi-ai 会认为流正常结束 —— 那就变成另一个测试了。
			// 先让这一帧真的出去再断：立刻 destroy 时对端一帧都收不到，
			// 链会走「还没开始就断了」的分支，同样不是要测的东西。
			await new Promise((resolve) => setTimeout(resolve, 150));
			res.destroy();
			return;

		default:
			res.writeHead(500, { 'content-type': 'application/json' }).end('{}');
	}
});

server.listen(PORT, '127.0.0.1', () => {
	console.log(`fake llm ready on http://127.0.0.1:${PORT}  script=${script.join(',')}`);
});
