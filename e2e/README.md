# 端到端验证（`e2e/`）

这里验证的是**用户实际装到的那个包**在被真的 dsh 加载后、面对真实 HTTP 故障时的行为。
单元测试证明不了这件事：`test/` 里的 adapter 是假的，只能说明分支逻辑按预期走。

## 为什么存在这一层（2026-11-25）

那天线上「没再报错」，一度被当成「插件修好了」。实际上是把会话改成了直连
`opendesign/deepseek-v4.1-flash` —— **回退链根本没被走到**。

> 没有流量的绿是假绿。

所以这层的判据不是「有没有报错」，而是：让链去请求一个行为已知的对端，然后检查
**它到底调了谁、调了几次、用了什么预算**。

## 跑

```bash
e2e/run.sh              # 全部场景
e2e/run.sh breaker      # 单个场景
e2e/run.sh --list       # 列出场景
```

环境变量：

| 变量 | 作用 |
|:--|:--|
| `PLUGIN_SPEC` | 装哪个，默认**本仓库路径**（link: 安装，测的是工作树源码）。设成 `@magic6/dsh-llm-resilience@0.5.10` 可做回归对照，设成 `@…@<版本>` 可验证 registry 上的包 |
| `E2E_WORK` | 工作目录（含独立 `DSH_HOME`），默认 `/tmp/dsh-llm-resilience-e2e` |
| `PORT_A` / `PORT_B` | 两个假 server 的端口，默认 8799 / 8798 |
| `DSH_BIN` | dsh 可执行文件，默认从 PATH 找 |

## 隔离性

- 独立 `DSH_HOME`：不碰用户的 profile、会话、凭据。
- 假 provider 指向 `127.0.0.1`，不产生任何真实 API 调用。
- 每次跑都重建工作目录，`stateFile` 从空开始。

## 场景

| 场景 | 假 server 行为 | 断言 |
|:--|:--|:--|
| `baseline` | 两个都正常 | fake-a 作答；fake-b **一次都没被请求** |
| `upstream400` | a 返回 `400 {"code":"upstream_error"}` | 必须 fallback 到 fake-b（**0.5.5 上这条失败**） |
| `genuine400` | a 返回真·请求错误 400 | 必须 fail fast，fake-b 不被请求 |
| `transient500` | a 一直 500 | 重试耗尽后 fallback |
| `exhausted` | 两个都 500 | 报 `FALLBACK_EXHAUSTED`，保留最后一次真实失败 |
| `malformed` | a 把两个工具调用塞进同一个 index | 不整轮作废，重试后 fallback |
| `effort-map` | 会话选 `max`；a 只声明 `low`/`high` | 请求必须进入链，a 收到就近映射后的 `high`（**0.5.10 上这条报 `UNSUPPORTED_REASONING_EFFORT`**） |
| `effort-omit` | 会话选 `max`；a 失败后回退到没有 thinking 元数据的 b | b 必须收到**没有** effort 参数的请求并正常作答（**0.5.10 上这条也报错**） |
| `probe-refail` | 三轮：打满 -> 探活也失败 -> 再查 | 探活失败要**重新锁**，不能放行 |
| `drop` | a 吐一段内容后就断流（不发 `[DONE]`） | 交宿主整步重放；用户只看到**一份**完整内容，fake-a 那半截不许出现 |
| `drop-mid-tool` | a 的工具调用吐出半截 arguments 就断 | 宿主看不到半成品调用（缓冲压到 block-end 才交付），透明回退 |
| `breaker` | 四轮：打满 -> 锁未过期 -> 锁过期 -> 恢复 | 见下 |

`breaker` 场景覆盖的是 `background: true` 的真实语义：

1. 打满阈值 -> 锁写入 `stateFile`，本轮由 fake-b 作答；
2. 锁未过期 -> fake-a **一次都不该被请求**；
3. 锁过期 -> 本轮仍由 fake-b 作答（后台探活不阻塞），但 fake-a 必须收到**一个探活请求**：
   无 tools、单条消息、预算 **不是 1**（**0.5.5 上这条失败**）；
4. 探活成功后 -> fake-a 恢复使用，`entries` 里不再有它。

## 加一个场景

在 `e2e/fake-llm-server.mjs` 的 `switch` 里加一个动作，再在 `run.sh` 的 `SCENARIOS`
与 `main()` 里各加一行。动作脚本是逗号分隔的顺序，用完重复最后一条。

## 回归对照：这套东西真的能抓 bug 吗

**能。** 拿旧版本跑同一套，它必须挂：

```bash
PLUGIN_SPEC='@magic6/dsh-llm-resilience@0.5.10' E2E_WORK=/tmp/e2e-old e2e/run.sh
```

实测结果：

| 版本 | 结果 |
|:--|:--|
| `0.5.5`（有 bug） | 在其当时的 10 个场景里 8 通过 **2 失败** —— `upstream400` 整轮失败、`breaker` 探活预算仍是 1 |
| `0.5.10`（已修 0.5.6 的两条） | 10 个旧场景全过；加上 `effort-map` / `effort-omit` 后 **12 个里 2 个失败**，复现用户原文 `provider "fallback" model "auto" does not support reasoning effort "max"` |
| `0.6.0` | **12 通过 0 失败**（DSH 0.2.2-rc.5）；两个 effort 场景也在 DSH 0.2.1-rc.5 通过 |

一条永远绿的测试什么也证明不了。**加场景时必须回答：它在旧版本上会不会红？**
如果不会，那个场景没有在测任何东西。

## `drop` 场景的断言为什么和直觉相反

fake-b **确实**会被请求，而且这是对的，不是 bug。

`result.delivered` 为真时插件不在原地换 target（那会把两段内容拼起来），而是抛给宿主
做**整步重放**；宿主重放同一步时，链按之前的记录跳过 fake-a、走 fake-b。所以正确的
断言不是「fake-b 一次不许被请求」，而是：

1. 用户最终看到的**只有一份**内容，且不含 fake-a 那段半成品；
2. 两个 target 的正文不能同时出现。

写这个场景时我一开始断言错了，改对之后才发现要测的是「宿主重放后不重复」，不是
「完全不重放」。**断言写错比没有测试更危险**——它会给人已经验证过的错觉。

## 一个容易踩的坑

**一次 dsh 跑会发两个请求**：主对话一次、生成会话标题一次。所以断言「fake-b 被请求 0 次」
时，别把它理解成「总共只发一个请求」；判断依据是**谁**被请求，不是总数。
