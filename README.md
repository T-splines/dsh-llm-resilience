# dsh-llm-resilience

[English](https://github.com/T-splines/dsh-llm-resilience/blob/main/README.en.md) | **简体中文**

**让不稳定的 LLM 网关表现得像可靠的一样——DeepSeek Harness 的按 target 重试、流式安全回退链与持久化熔断。**

这个插件来自作者部署中实际遇到的失败场景：**OpenDesign Go** 的工具调用流与 API 连接会
间歇性不稳定。一条工具调用流损坏、一次传输中断，或者一次以普通 500 返回的会员/额度错误，
就可能让整个 agent step 失败。DSH 内置的 `retryPolicy` 是 provider 级的：它能对同一条路由
退避，但不能换 provider/model，也没有熔断。在日常使用中，这个插件把 OpenDesign Go 从
**基本不可用**提升到了**基本可靠可用**：安全的重试吸收瞬时故障；网关额度耗尽或坏掉时由
备用 provider 接手；持久化熔断器阻止继续打一个已经死掉的上游。

> 本插件是独立项目，与 OpenDesign、DeepSeek 没有隶属或背书关系；
> OpenDesign Go 只是促成这套设计的实际部署场景。该失败模式并非它独有：任何会间歇性
> 损坏工具调用流、或把额度错误伪装成普通 500 的网关，都适用同一条链。

- [为什么需要它](#为什么需要它)
- [差异点](#差异点)
- [注册了什么](#注册了什么)
- [安装](#安装)
- [配置](#配置)
- [错误分类](#错误分类)
- [流式输出、工具调用与整步重放](#流式输出工具调用与整步重放)
- [熔断](#熔断)
- [设置页](#设置页)
- [边界与不做的事](#边界与不做的事)
- [测试](#测试)
- [兼容与迁移](#兼容与迁移)

## 为什么需要它

DSH 的 `retryPolicy` 已经在 provider 级重试，但：

- 退避倍率固定为 2，不能配 1.5；
- `agent/request-error` 只能重试**同一条路由**，不能换 provider/model；
- 没有熔断：一个 provider 整体不可用时，每个 step 仍然先打它；
- `MALFORMED_RESPONSE`（工具调用流损坏）与工具**执行**失败需要分开处理。

本插件注册一个合成 provider route（默认 `fallback`，模型 `auto`），内部按链调用真实
provider/model：

```
fallback/auto
  ├─ target 0: primary-gateway/your-model       独立重试预算 + 独立熔断
  ├─ target 1: backup-provider/your-model       独立重试预算 + 独立熔断
  └─ target 2: local/your-model                 独立重试预算 + 独立熔断
```

每个 target 有自己的重试预算、退避曲线和熔断；切到下一个 target 时退避从头开始，
不继承上一条已经翻倍过的延迟。

## 差异点

- **每个 target 独立重试。** `maxRetries` / `initialDelayMs` / `multiplier`（支持 1.5）/
  `maxDelayMs` / `jitterRatio` 都按 target 配置。
- **按错误类型决策。** 以 `SERVER` 500 返回的会员/额度错误直接 fallback；普通
  500/超时/传输错误重试；请求本身无效直接失败，不换 target。`codeActions` 可以覆盖默认表。
- **流式安全的工具调用。** 文本/推理增量立即透传；tool-call 的 block-start/delta 缓冲到
  `block-end` 才交付。因此工具参数非法（没有 block-end）时可以丢弃缓冲并重试，
  宿主不会看到重复输出。
- **整步重放续点。** 内容已经交付后再失败，不能在同一请求内换 target；插件记住
  `sessionId + 请求指纹`，宿主重放同一步时从下一个 target 开始，并且计划是**轮转**而不是
  截断，覆盖整条链。失败的是链尾时原地重试它——绝不把可重试失败改写成终态
  `FALLBACK_EXHAUSTED`。
- **持久化熔断，按 provider + model 记账。** 连败 N 次锁一个时间窗；到期进入 half-open
  探活（前台或后台）。状态原子写进 `stateFile`，多进程用锁 + tombstone 合并，
  重启不会忘掉尚未达到阈值的连败计数。
- **全局预算。** `limits.maxTotalMs`（默认 10 分钟）与 `limits.maxAttempts`（默认 50）
  跨 target、跨重试累计；退避等待也计入 deadline。任何 target × 重试的组合都不能把一步
  拖到无上限。
- **请求级恢复码原样透传。** `IMAGE_OFFLOAD_REQUIRED`（含 `offloadImages`）与
  `CONTEXT_WINDOW_EXCEEDED` 原样抛出，让宿主的图片卸载 / 上下文压缩先恢复。
- **设置页。** 编辑链、上下移动 target、查看每次重试计划、实时看熔断状态
  （`closed / open / half-open / probing`）。
- **有测试。** 90 个 `node --test` 用例，另有隔离 DSH + 本地假 OpenAI server 的端到端冒烟
  （见 [DESIGN.md](DESIGN.md)）。

## 注册了什么

| 项 | 值 |
|:--|:--|
| 合成 route | `fallback`（可配置） |
| 合成模型 | `auto` |
| profile entry id | `llm-fallback`（为设置兼容保持不变） |
| 包名 | `@magic6/dsh-llm-resilience` |
| 默认状态文件 | `$DSH_HOME/storages/llm-resilience/state.json` |

`targets: []`（或所有 target `enabled: false`）时 route 仍然注册但保持 dormant：
可以先在设置页建链，再启用。

## 安装

要求：DSH `0.2.1-rc.x` / `0.2.2-rc.x`、Node.js 20+。

### 从 npm 安装

```bash
dsh plugin --profile web add @magic6/dsh-llm-resilience
```

### 从源码安装

```bash
git clone https://github.com/T-splines/dsh-llm-resilience.git
cd dsh-llm-resilience
dsh plugin --profile web add "$PWD"
```

包本身是 bundle（`dsh.bundle.patch`），`llm-fallback` entry 已由 bundle 挂载。**覆盖这个
entry**，不要再 `insert` 一份。在 `$DSH_HOME/profiles/<profile>/cordis.patch.yml` 里整体
替换 `config`：

```yaml
- id: llm-fallback
  name: '@magic6/dsh-llm-resilience'
  config:
    enabled: true
    route: fallback
    targets:
      - enabled: true
        provider: primary-gateway
        model: your-model
        maxRetries: 5
        initialDelayMs: 1500
        multiplier: 2
        maxDelayMs: 20000
        jitterRatio: 0.3
      - enabled: true
        provider: backup-provider
        model: your-backup-model
        maxRetries: 3
        initialDelayMs: 1000
    breaker:
      failureThreshold: 5
      lockMs: 3600000
      probe:
        enabled: true
        background: false
        timeoutMs: 10000
        maxTokens: 256
        prompt: 'ping'
      stateFile: '$DSH_HOME/storages/llm-resilience/state.json'
    limits:
      maxTotalMs: 600000
      maxAttempts: 50
    toolCalls:
      retryMalformed: true
```

把 `primary-gateway` / `backup-provider` 换成 DSH 模型目录里的真实 provider id（设置页的
只读下拉框里能看到）。provider 不存在的 target 会报 `NO_ADAPTER`，链继续往后走，不会假装
它服务成功。

然后把 agent 的默认模型指到合成 route：

```yaml
- id: agent-default-model
  config:
    provider: fallback
    model: auto
```

不启动 agent 验证组合树（`web` 是常见 profile 名，换成你自己的）：

```bash
dsh --profile web --dump-config | grep -A8 'id: llm-fallback'
```

> 用 `--patch` 覆盖已有的 `llm-fallback` 条目时，要把 `targets` 数组写全：DSH 的配置合并
> 会给省略的数组字段补空默认值，只写 `breaker` 会把链清空。

**不要给会员/额度类错误配 10 次重试。** 它们是确定性的 provider 状态，重试同一个 target
只会浪费预算，应该在第一次失败后直接 fallback。

## 配置

| 字段 | 含义 |
|:--|:--|
| `enabled` | 总开关；禁用时 route 仍存在但拒绝请求 |
| `route` | 合成 provider 名（默认 `fallback`）；不能出现在 `targets` 里 |
| `targets[]` | 有序的 `{ provider, model, enabled, label, maxRetries, initialDelayMs, multiplier, maxDelayMs, jitterRatio }` |
| `breaker` | `failureThreshold`、`lockMs`、探活参数（`enabled` / `background` / `timeoutMs` / `maxTokens` / `prompt`）、`stateFile` |
| `limits` | `maxTotalMs`、`maxAttempts`；`0` 表示不限制该维度 |
| `toolCalls.retryMalformed` | 重试模型输出损坏的工具调用（默认 `true`）；工具**执行**失败不支持重试 |
| `codeActions` | 按稳定错误码覆盖默认动作（`retry` / `fallback` / `fail`） |

## 错误分类

| 错误 | 动作 | 理由 |
|:--|:--|:--|
| `SERVER` + membership/entitlement/quota/billing/credit/plan | fallback | 确定性账号状态，重试无用 |
| `SERVER` / `TIMEOUT` / `TRANSPORT` / `RATE_LIMIT` / `EMPTY_RESPONSE` / `STREAM_CLOSED` | retry | 瞬时故障 |
| `MALFORMED_RESPONSE` | retry | 模型输出损坏；重试整个 LLM 请求是安全的 |
| `AUTH` / `INVALID_CREDENTIAL` / `MISSING_CREDENTIAL` | fallback | 换一个 provider |
| `QUOTA` / `ACCOUNT_QUOTA` | fallback | 换 provider / 额度 |
| `NO_ADAPTER` / `UNKNOWN_MODEL` / `MODEL_NOT_FOUND` | fallback | 该 target 不可用 |
| `ABORTED` / `CANCELLED` | fail | 调用方取消 |
| `INVALID_REQUEST` + `upstream_error` 等网关包装标记 | fallback | 网关把自己上游的故障包成 400；请求体本身没问题，链上别的 target 能成功 |
| `UNSUPPORTED_OPTION` / `INVALID_REQUEST` / `UNSUPPORTED_CONTENT` | fail | 请求本身的问题，换 target 也修不好 |
| `IMAGE_OFFLOAD_REQUIRED` | fail（原样抛出） | 宿主的图片卸载恢复必须看到它 |
| `CONTEXT_WINDOW_EXCEEDED` | fail（原样抛出） | 宿主的上下文压缩恢复必须看到它 |
| 未知 code | fallback | 最后一个 target 仍会抛原始错误，不静默吞掉 |

`IMAGE_OFFLOAD_REQUIRED` 与 `CONTEXT_WINDOW_EXCEEDED` 不可覆盖：它们是 DSH 的请求级恢复协议，
宿主的监听器依赖原始 code 与元数据。

网关包装识别只在 `INVALID_REQUEST` / `PI_AI_ERROR` / `UNKNOWN` 这三个「状态码文本猜出来的」
分类上生效，且要求报文里出现 `upstream_error` / `upstream_timeout` / `bad_gateway` /
`gateway_error` 之一。理由：pi-ai 见到报文里的 `400` 就判 `INVALID_REQUEST`，但同一份
payload 换下一个 target 常常 200（OpenDesign Go 实测：eco 400 / flash 200 / dsc 200）。
真正的请求错误（工具定义缺字段、载荷超限、参数非法）没有这些标记，仍然 fail。
`codeActions` 里的显式覆盖依然优先。

## 流式输出、工具调用与整步重放

- 只有在**还没有向调用方交付可见内容**时，才能在同一请求内换 target。
- 文本/推理增量立即透传。
- tool-call 的 block-start/delta 缓冲到 `block-end`；参数非法的工具调用（没有 `block-end`）
  可以丢弃并安全重试。
- 已经交付可见内容后再失败，交给宿主 `dsh-llm-retry` 整步重放。插件记录请求指纹与已试到的
  target，重放时从下一个 target 开始；计划**轮转**而不是截断，失败点之前的 target 不会消失。
  失败的是链尾时原地重试它。
- 合成 route 写下的 replay 信封在请求到达上游前会还原成真实 target 的 provider/model，
  保留签名与 id。旧包名 `dsh-llm-fallback` 写下的信封仍然可读。

## 熔断

```
closed --(连续 failureThreshold 次失败)--> open
open --(lock 到期)--> half-open
half-open --(探活成功)--> 下一次真实请求成功后 closed
half-open --(探活失败)--> 再锁一轮
half-open --(探活无定论)--> 解锁，交回真实流量判断
```

- 探活默认给 `maxTokens: 256`，不是 1。实测（stream 模式）`max_tokens: 1` 时推理模型
  会把预算全花在思考上、返回空内容，pi-ai 判 `EMPTY_RESPONSE`；`64` 才稳定出 content。
  探针太小时恢复检测永远失败，健康 provider 被自己的探针锁死（0.5.6 修的就是这个）。
- 即便如此，探针仍可能因为「自身太简陋」而失败（返回空内容 `EMPTY_RESPONSE`、个别
  provider 拒绝退化请求 `INVALID_REQUEST`）。这些 code 描述的是**探针本身**，不是
  target 的健康状况：此类结果记为「无定论」，直接解锁并把判断交回真实请求。真坏的
  target 重新攒满 `failureThreshold` 次真实失败就会再锁。网关包装的上游故障
  （`400 code=upstream_error`）例外：它同时说明真实请求也会失败，仍然继续锁。
- 状态按 `provider + model` 记账，不按 provider 整体记账。
- `stateFile` 用锁 + 读-合并-写原子更新；并发进程取锁更晚/连败更多的条目；成功清除写
  tombstone，旧锁不会被复活。
- 未达阈值的连败也会落盘（`updatedAt` 是合并时间轴），重启不会把计数清零。
- 全部 target 都 open/probing 时抛 `ALL_TARGETS_LOCKED`，附每个 target 的 `lockedUntil`，
  不会硬打最后一个被锁的 provider。

## 设置页

Plugins → Installed → `@magic6/dsh-llm-resilience` → **Model fallback chain**：

- 每个 target 一行：启用、provider、model（从会话模型目录读出的只读下拉）、显示名、
  重试参数、上下移动、删除、新增；
- 「重试计划」悬停：每次重试一行，`jitter > 0` 时显示区间；
- 熔断与全局预算字段；
- 「运行状态」每 4 秒从宿主读取：`closed / open / half-open / probing`、剩余锁定时间、
  连败与累计锁次数；
- 非环回浏览器拿到的是宿主内存态视图，卡片会明说，而不是把插件默认值当成部署策略。

## 边界与不做的事

- **工具执行失败不重试。** cordis 4.1 的 `tools/execute` waterfall 的 `next()` 是单次调用，
  再次调用会抛 `next() called multiple times`；自动重放 tool body 需要 DSH 核心/executor
  提供钩子。本插件不提供「配置了但静默无效」的开关。模型输出损坏的工具调用重试不受影响。
- **不无限重试。** 全局 deadline 与尝试上限是必须的；`0` 只是关闭该维度，不建议生产使用。
- **不替代 `@deepseek-ai/dsh-llm-retry`。** 后者仍负责 step 级重试；本插件负责 provider 选择
  与请求级韧性。
- **不会为了回退而缓冲整个流。** 已经交付可见内容后再换 target 会重复输出，所以交给宿主
  整步重放。

## 测试

```bash
npm test
```

90 个用例覆盖退避/抖动、错误分类、链校验、适配器执行、流式安全、整步重放轮转、熔断持久化
与多进程合并、全局预算、后台探活、设置页纯函数，以及 replay 信封（含旧包名兼容）。
隔离 `DSH_HOME` + 假 OpenAI-compatible server 的端到端冒烟见 [DESIGN.md](DESIGN.md)。

## 支持的平台

测试套件在下面这些环境里**实际跑过并通过**，不是「应该能跑」：

| 平台 | 版本 | 结果 | 验证方式 |
|:--|:--|:--|:--|
| macOS | 26.6.2 arm64 | ✅ 99/99 | 本机全量 `npm test` |
| Windows | 11 22631 x64 | ✅ 99/99 | 真机全量 `npm test` |
| Linux | ubuntu-latest x64 | ✅ 99/99 | GitHub Actions（Node 20 / 22） |

Windows 一行是 2026-11-25 加的：在那之前 CI 只跑 `ubuntu-latest`。本插件的
99 个用例在真机上一次通过，但同一批验证在 `dsh-compaction-policy-engine`
上抓出了两个只在 Windows 挂的测试 —— 所以三个仓库都加了 `windows-latest`
CI 任务，而不是根据这一次的运气决定。

> 只列跑过测试的平台。没在这里出现 ≠ 不支持，只是还没人验证过 ——
> 如果你在别的平台跑通了，欢迎提 PR 把这一行补上。

## 端到端自测

单元测试证明不了「装到你机器上的这个包，在被真的 dsh 加载、面对真的 HTTP 故障时
会怎么做」。仓库里因此有一层端到端验证：

```bash
npm run test:e2e      # 等价于 e2e/run.sh
```

它做的是：起一个**独立 `DSH_HOME`**、建临时 profile、从 npm 装这个包、配两个**假
provider**（指向 `127.0.0.1`，不产生真实 API 调用），然后让链去请求它们 ——
行为由命令行给定（正常 / 500 / 网关包装 400 / 空内容 / 畸形工具调用…）。

断言不看「有没有报错」，而看**谁被调用了、调了几次、用了什么预算**。细节与场景
清单见 [e2e/README.md](e2e/README.md)。

> 这套东西的验收标准写在那个 README 里：加一个场景，它必须在**旧版本上会红**。
> 一条永远绿的测试证明不了任何事。

## 兼容与迁移

- DSH `0.2.1-rc.x` / `0.2.2-rc.x`（`engines.dsh` 为 `>=0.2.1-0 <0.3.0-0`）、Node.js 20+。
- **0.5.0 从 `dsh-llm-fallback` 改名。** profile entry id 保持 `llm-fallback`，设置和已有
  patch 继续可用；把 `name:` 字段改成 `@magic6/dsh-llm-resilience` 即可。
- 默认熔断状态文件移到 `$DSH_HOME/storages/llm-resilience/state.json`；想继续用旧文件就显式
  设置 `stateFile`。
- 旧包名写下的 replay 信封仍然可读（`dsh-llm-fallback` 作为 legacy kind 接受）。

## 报告问题

发现 bug 请直接开 issue —— 不用先确认是不是自己的配置问题，贴上来我们一起看：

- 🐞 **[Bug report](https://github.com/T-splines/dsh-llm-resilience/issues/new?template=bug_report.yml)**
  —— 行为不对、崩溃、该 fallback 没 fallback、熔断恢复不了。
- ❓ **[Config question](https://github.com/T-splines/dsh-llm-resilience/issues/new?template=config_question.yml)**
  —— 能跑，但行为和配置不一致。

提 issue 时如果方便，附上这几样，通常当天就能定位：

1. 插件版本与 DSH 版本；
2. 操作系统（Windows 与 macOS 的路径和文件锁实现不同，行为确有差异，别省）；
3. 原始的 `code` 和 `message`，不要转述；
4. 如果链跳过了某个 target，附上熔断状态文件（`stateFile` 指向的那个）。

安全相关问题请不要开公开 issue，按 [SECURITY.md](SECURITY.md) 私下报。

## 许可

MIT，见 [LICENSE](LICENSE)。
