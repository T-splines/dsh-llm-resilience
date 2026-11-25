/**
 * 思考强度（reasoning effort）的跨 provider 映射。
 *
 * 宿主在进入适配器之前，会用**合成模型**声明的档位校验 `reasoningEffort`：
 * 只要不匹配就直接报 `UNSUPPORTED_REASONING_EFFORT`，请求根本到不了链。
 * 各上游 provider 的档位名字和集合又不一致（`off`/`none`、`xhigh`/`max`、
 * 只有 `low`/`high` 的模型……），所以合成模型必须声明一个足够宽的并集，
 * 由本模块在每条 target 上就近翻译，翻译不了就省略参数、使用目标默认值。
 *
 * 档位按 0–100 排序，常见别名都落在同一把尺子上；未知档位不猜，优先目标
 * 默认，再退到最高档——保证「用户选了一个上游不认识的名字」也不会把整条链
 * 变成不可用。
 *
 * @module dsh-llm-resilience/effort
 */

export const AUTO_EFFORT = 'auto';

/** 与 `dsh-llm-pi-ai` 的 THINKING_LEVELS 一致，顺序即升级顺序。 */
export const CANONICAL_EFFORTS = Object.freeze([
	{ id: 'off', name: 'Off', rank: 0 },
	{ id: 'minimal', name: 'Minimal', rank: 10 },
	{ id: 'low', name: 'Low', rank: 25 },
	{ id: 'medium', name: 'Medium', rank: 50 },
	{ id: 'high', name: 'High', rank: 75 },
	{ id: 'xhigh', name: 'Xhigh', rank: 90 },
	{ id: 'max', name: 'Max', rank: 100 },
]);

const RANK_BY_ID = new Map(CANONICAL_EFFORTS.map((entry) => [entry.id, entry.rank]));

/** 常见 provider 的别名 → 同一把 0–100 尺子。 */
const ALIAS_RANKS = new Map([
	['none', 0],
	['disabled', 0],
	['disable', 0],
	['no', 0],
	['zero', 0],
	['0', 0],
	['minimum', 10],
	['min', 10],
	['light', 25],
	['lowest', 25],
	['balanced', 50],
	['balance', 50],
	['normal', 50],
	['mid', 50],
	['middle', 50],
	['standard', 50],
	['default', 50],
	['auto', 50],
	['deep', 75],
	['highly', 75],
	['x-high', 90],
	['extra-high', 90],
	['extra_high', 90],
	['very-high', 90],
	['very_high', 90],
	['veryhigh', 90],
	['maximum', 100],
	['highest', 100],
	['ultra', 100],
	['ultra-high', 100],
	['maximal', 100],
]);

function normalized(id) {
	return String(id).trim().toLowerCase().replace(/[\s_]+/g, '-');
}

/**
 * 档位 → 0–100 的排序值。
 *
 * 认不出的名字返回 `undefined`：这时不做「听起来差不多」的猜测，避免把
 * `custom:foo` 误当成 medium 发给另一个 provider。
 */
export function effortRank(id) {
	if (typeof id !== 'string') return undefined;
	const value = normalized(id);
	if (value === '') return undefined;
	const known = RANK_BY_ID.get(value);
	if (known !== undefined) return known;
	const alias = ALIAS_RANKS.get(value);
	if (alias !== undefined) return alias;
	if (/^\d+$/.test(value)) {
		const numeric = Number(value);
		if (numeric >= 0 && numeric <= 100) return numeric;
	}
	return undefined;
}

/** 规范化后的比较键；只用于判等，不会改变真正发出去的 id。 */
export function effortKey(id) {
	return typeof id === 'string' ? normalized(id) : '';
}

/** 用户配置里是否表示「跟随会话」；空串也按 auto 处理，兼容旧配置。 */
export function isAutoEffort(value) {
	return value === undefined || value === null || String(value).trim() === '' || effortKey(value) === AUTO_EFFORT;
}

function canonicalEntries() {
	return CANONICAL_EFFORTS.map(({ id, name }) => ({ id, name }));
}

/**
 * 合成模型可见的档位：标准档位在前，再追加各 target 自己声明的自定义档位。
 *
 * 即使所有 target 都不声明 reasoning 也会返回标准档位。这是刻意的：合成模型
 * 的职责是**先接住**宿主的校验，再由每条 target 决定发什么；否则「链里有一个
 * 没写 thinking 配置的模型」就会让整条链拒绝任何显式档位。
 */
export function mergeEfforts(...lists) {
	const merged = canonicalEntries();
	const seen = new Set(merged.map((entry) => entry.id));
	for (const list of lists) {
		for (const effort of Array.isArray(list) ? list : []) {
			if (effort === null || typeof effort !== 'object') continue;
			const id = typeof effort.id === 'string' ? effort.id.trim() : '';
			if (id === '' || seen.has(id)) continue;
			seen.add(id);
			merged.push({
				id,
				name: typeof effort.name === 'string' && effort.name.length > 0 ? effort.name : id,
				...(typeof effort.description === 'string' && effort.description.length > 0
					? { description: effort.description }
					: {}),
			});
		}
	}
	return merged;
}

/**
 * 从一个候选集合里选出与 `requested` 最近的档位。
 *
 * 规则（按优先级）：
 * 1. id 完全一致 → 原样使用；
 * 2. 能算出排序值 → 绝对差最小；等距时选更高的一档（用户说 max 时不要
 *    悄悄降成 low，宁可更接近「多想」）；
 * 3. requested 认不出 → 最高档；没有可排序候选时才用目标的 defaultEffort；
 * 4. 再不行 → 第一个候选。
 *
 * @returns 选中的 id；候选为空时 `undefined`。
 */
export function chooseEffort(requested, efforts, { defaultEffort } = {}) {
	const candidates = (Array.isArray(efforts) ? efforts : []).filter(
		(effort) => effort !== null && typeof effort === 'object' && typeof effort.id === 'string' && effort.id !== '',
	);
	if (candidates.length === 0) return undefined;

	const wanted = typeof requested === 'string' ? requested.trim() : '';
	if (wanted !== '') {
		const exact = candidates.find((effort) => effort.id === wanted);
		if (exact !== undefined) return exact.id;
	}

	const hasDefault =
		typeof defaultEffort === 'string' &&
		defaultEffort !== '' &&
		candidates.some((effort) => effort.id === defaultEffort);

	const targetRank = effortRank(wanted);
	if (targetRank === undefined) {
		return highestEffort(candidates, hasDefault ? defaultEffort : undefined);
	}

	let best;
	let bestDistance = Infinity;
	for (const effort of candidates) {
		const rank = effortRank(effort.id);
		if (rank === undefined) continue;
		const distance = Math.abs(rank - targetRank);
		if (
			distance < bestDistance ||
			(distance === bestDistance && best !== undefined && rank > effortRank(best.id))
		) {
			best = effort;
			bestDistance = distance;
		}
	}
	if (best === undefined) return highestEffort(candidates, hasDefault ? defaultEffort : undefined);
	return best.id;
}

/** 最高档；一个能排序的候选都没有时，才退到目标默认，最后退到第一个候选。 */
function highestEffort(candidates, fallback) {
	let best;
	let bestRank = -Infinity;
	for (const effort of candidates) {
		const rank = effortRank(effort.id);
		if (rank !== undefined && rank > bestRank) {
			best = effort;
			bestRank = rank;
		}
	}
	if (best !== undefined) return best.id;
	if (typeof fallback === 'string' && candidates.some((effort) => effort.id === fallback)) return fallback;
	return candidates[0].id;
}

/**
 * 为一条 target 算出实际要发出去的档位。
 *
 * @param requested - 会话/宿主要求的档位（可能没有）。
 * @param override - target 配置的 `reasoningEffort`；`auto` 表示跟随会话。
 * @param info - 该 target 的 `resolveModelInfo` 结果。
 * @returns `{ desired, effort, reason }`：
 *   - `desired`：翻译前的意图；没有意图时为 undefined；
 *   - `effort`：实际要发的 id；`undefined` 表示省略参数、使用目标默认；
 *   - `reason`：`auto` / `unspecified` / `exact` / `mapped` / `unsupported`。
 */
export function planTargetEffort({ requested, override, info } = {}) {
	if (isAutoEffort(override)) {
		if (isAutoEffort(requested)) {
			return { desired: undefined, effort: undefined, reason: 'auto' };
		}
		const desired = String(requested).trim();
		return mapDesired(desired, info);
	}

	const desired = String(override).trim();
	return mapDesired(desired, info);
}

function mapDesired(desired, info) {
	const efforts =
		info !== null && typeof info === 'object' && info.reasoning !== undefined
			? info.reasoning.efforts
			: undefined;
	if (!Array.isArray(efforts) || efforts.length === 0) {
		return { desired, effort: undefined, reason: 'unsupported' };
	}
	const effort = chooseEffort(desired, efforts, { defaultEffort: info.reasoning.defaultEffort });
	if (effort === undefined) return { desired, effort: undefined, reason: 'unsupported' };
	return { desired, effort, reason: effort === desired ? 'exact' : 'mapped' };
}

/**
 * 从 provider 的报错文本里认出「它支持哪些档位」。
 *
 * 只在运行时兜底使用：目标模型能力元数据过期时，错误原文往往就是最准确的
 * 能力表。保守地只认标准档位与常见别名，避免把普通英文单词当成档位。
 */
const PARSE_IDS = [
	'off',
	'none',
	'minimal',
	'minimum',
	'low',
	'lowest',
	'medium',
	'high',
	'xhigh',
	'x-high',
	'extra-high',
	'very-high',
	'max',
	'maximum',
	'highest',
	'ultra',
];

export function parseSupportedEfforts(message) {
	if (typeof message !== 'string' || message.length === 0) return [];
	const found = [];
	const seen = new Set();
	for (const id of PARSE_IDS) {
		const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		if (new RegExp(`(^|[^a-z0-9_-])${escaped}([^a-z0-9_-]|$)`, 'i').test(message) && !seen.has(id)) {
			seen.add(id);
			// 别名统一成它自己的 id；后面 chooseEffort 会按排序值再选。
			found.push({ id, name: id });
		}
	}
	return found;
}