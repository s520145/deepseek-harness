---
description: "限制次数的输出触顶自动续接，以及保守的重复工具保护。"
kind: "package-reference"
---

# @deepseek-ai/dsh-output-continuation

[English](README.md) | 中文

## 概述

当最新的结构化模型结果是 `max-tokens` 时续接任务。默认每个 turn 最多自动续接两步，中间成功的工具步骤不会重置次数。正常停止、错误、限流和取消不触发续接。模型预算保持不变。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用本包

基础 bundle 启用本插件。`maxContinuations` 必须是 0 到 10 的整数；默认值为 2，0 会关闭自动续接及其工具守卫。无效值导致插件加载失败。

```yaml
- name: '@deepseek-ai/dsh-output-continuation'
  config:
    maxContinuations: 2
```

队列中的人工 next-turn 或 next-step 输入优先，并结束当前 turn 的自动续接链。取消时会移除本插件的待处理输入，即使保留了其他 inbox 项。每次自动输入都有独立的持久收据；移除输入或热重载插件不会恢复该 turn 的续接额度。最后一次允许的续接会要求模型简洁完成，或向用户交接剩余工作。再次触顶则以正常的 `max-tokens` 原因结束 turn。

<a id="understand-the-implementation"></a>
## 理解实现

插件注册仅在 Host 使用的 `outputContinuation` Session Projection，增量折叠开放的 turn、最新 assistant 结果、已发出输入身份和工具尝试身份。按 message id 对 inbox 插入和已接纳 user-message 事件中的同一输入去重。每个来源携带 `turn`、`triggerAssistantSeq` 和 `attempt`；恢复或热重载后，已结束 turn 的旧输入不能重新接纳。

`agent/turn-stopping` 在当前触顶结果尚未取消时，排入一个不唤醒驱动的 next-step 输入。`agent/pre-step` 先委托下游策略，仅当最终接纳消息仍包含这个有效输入时设置 `resumesAfterMaxTokens`。核心循环负责相应的 turn 结束状态转换。正常模型历史保留，本包不会回放或执行截断流中的工具片段。

自动输入被接纳后，`tools.guard` 拒绝当前 turn 中同名且完整 JSON 参数相同的重复工具调用。对象键顺序归一化，数组顺序和值仍有意义。Projection 保存 SHA-256 身份摘要，不复制参数正文。当前原生或 PTC-start 记录不会被误判为它自己的重复项；同批更早调用和嵌套 PTC 调用参与比较。首次自动续接前，未有对应记录的直接执行器调用会在分派前追加 `output-continuation/tool-dispatched`。自动续接期间，每次实际分派都追加该收据，因此即使调用方复用调用 id，执行中的保护也能跨热重载保留。收据表示工具体可能已执行，绝不会当作当前调用而排除。这个必读审计事件仅携带 turn、调用 id 和身份摘要，不进入模型上下文。不认识该事件的旧 reader 会拒绝接纳会话。所有工具都参与，包括并发安全的工具。拒绝时不会代入此前结果。

结果不确定的已记录调用按可能已执行处理。这也会拒绝此前已被拒绝调用的同参数重试：守卫不会从通用错误结果推断操作没有产生副作用。人工输入或 turn 边界结束守卫。注册属于插件实例，持久收据与调用身份由 Projection 重建。

<a id="further-exploration"></a>
## 进一步探索

- [Agent loop](../../core/agent-loop/README.zh.md) 负责输入接纳、步骤执行和 turn 结束。
- [Tools 子系统](../../../docs/subsystems/tools.zh.md) 定义执行器守卫和嵌套 PTC 分派。
- [Session Projection](../../session/session-projection/README.zh.md) 负责增量回放和持久缓存验证。

<a id="model-experience"></a>
## 模型体验

### 自动续接输入

#### 模型看到什么

符合条件的输出触顶后，模型收到以下 notice。`{attempt}` 和 `{limit}` 是整数。最后一次允许的输入将倒数第二行替换为下方的最终次数提示。

##### 续接通知

```markdown
Your previous response reached its output limit. Continue the unfinished task from the recorded history. This is automatic continuation {attempt} of {limit} for this turn.
Keep completed work and recorded tool results; do not repeat tool calls that already ran or may have run. Tool calls in the truncated response were not executed; issue any still-needed calls again with complete arguments. Do not reconstruct or execute partial tool arguments.
Continue concisely and finish when the task is complete.
Exact repeated tool calls are blocked during automatic continuation, including calls whose earlier outcome is uncertain. Different arguments do not guarantee that a repeated side effect is safe.
```

##### 最后一次提示

```markdown
This is the last automatic continuation. Finish concisely if possible; otherwise explain the remaining work and ask the user to continue.
```

#### Token 影响

每次被接纳的续接增加一条保留的 notice 和一次正常模型请求，次数受当前 turn 的配置额度限制。中间工具步骤仍会增加其正常请求和结果。本包不会提高输出预算或改变压缩阈值。

#### KV Cache 影响

Notice 追加在已有历史之后，保留原本可复用的前缀。插件热重载重建收据，不重写模型历史。Provider 的缓存可用性不属于本包保证。

### 重复调用拒绝

#### 模型看到什么

工具执行器返回错误，不调用重复操作：

##### 拒绝结果

```markdown
Error: Automatic continuation blocked an identical tool call that already ran or may have run in this turn. Inspect the recorded result and continue without repeating that operation. No previous success result has been substituted.
```

#### Token 影响

每个被拒绝的原生调用增加标准工具错误结果。嵌套 PTC 拒绝通过普通工具错误路径传回程序，其外层程序结果决定模型看到的内容。守卫不引用参数正文。

#### KV Cache 影响

原生拒绝结果追加到已有历史。守卫不添加工具 schema，不替换此前结果，并保留原本可复用的前缀。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- 不同参数可能描述同一副作用；规范身份不保证语义去重或恰好执行一次。
- 通用错误结果不能证明操作从未执行。保守拒绝相同重试可能需要人工介入。
- 截断响应可能只有思考或未完成工具调用。续接保留已有历史，不保证恢复缺失参数或 provider 隐藏状态。
- 次数限制约束自动续接输入，不约束普通工具步骤数量或一个 turn 的总 token。

<a id="dev-note"></a>
### 开发备注

无。
