/**
 * 会话日志里的 fallback 事件。
 *
 * 这些记录是 `plugin:` 命名空间下的 **ignorable** 事件：认识的插件可以读，
 * 不认识的前端会保留并跳过，不进入模型可见的 surface，也不影响 fork/resume。
 * 记录失败绝不能影响正在进行的 LLM 请求，所以这里吞掉所有异常并只警告一次。
 *
 * @module dsh-llm-resilience/session-log
 */

import { appendPluginRecord } from '@deepseek-ai/dsh-session';

export const RECORD_TYPE = 'plugin:llm-fallback';

/**
 * @param sessions - 宿主 `ctx.sessions`；没有它时返回空记录器。
 * @param logger - cordis logger。
 * @param append - 测试注入，默认 `appendPluginRecord`。
 * @returns `(sessionId, event) => void`
 */
export function createSessionRecorder(sessions, logger, append = appendPluginRecord) {
	let warned = false;
	return (sessionId, event) => {
		if (sessionId === undefined || sessions?.get === undefined) return;
		let session;
		try {
			session = sessions.get(sessionId);
		} catch {
			return;
		}
		if (session === undefined) return;
		try {
			append(session, RECORD_TYPE, { at: Date.now(), ...event });
		} catch (error) {
			if (warned) return;
			warned = true;
			logger?.warn?.(
				`llm-resilience: cannot append session record: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	};
}
