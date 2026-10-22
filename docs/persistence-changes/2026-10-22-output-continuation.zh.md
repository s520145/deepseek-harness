---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-22-output-continuation

[English](2026-10-22-output-continuation.md) | 中文

## 概述

新增持久化输出续接归属标记和必读工具派发摘要收据，用于有界恢复。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-22-output-continuation
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-13-user-rpc-principal"
    after: "ad4b1da619d5ae28f5b5bd9f60f109b25192783d2be6151ef2de651a5f3a5a64"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-13-user-rpc-principal"
    after: "cea25653b16c1212b9cd3ddbc74d9dc70341c4b4525136a788871d124ad63b9e"
    decision: same-version
  - root: "event:output-continuation/tool-dispatched"
    previous: null
    after: "63cfa89239f9c953c7672cddc7aee1868ef1746ed2ccca5726701c52716bbeff"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-13-user-rpc-principal"
    after: "1b3289d75e40159b487594950725db619914623758390c75218ba5294208f863"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-13-user-rpc-principal"
    after: "d27eaae9cf85dae4cc916bb64aa451a0cbfb4f8f5ecfd252d3c66e44968ba6c0"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有记录仍有效。消息来源是可合并扩展的上下文通知，读取器保留未知生产者类型。派发摘要收据是仅日志的必读事件：缺少该判别值的旧读取器会在恢复、追加或尾部修复前拒绝相关 Session。此安全拒绝允许保持当前 Session 格式版本，不改写已提交代际。新读取器从原生、PTC 和摘要记录混合日志中重建次数与派发标识。

<a id="verification"></a>
## 验证

28 项输出续接运行时测试和 2 项真实 Loader 测试通过；82 项 AgentLoop 测试通过。36 项持久化准入与来源测试通过，涵盖在读写修改前拒绝未知必读事件并保留原始字节。

<a id="dev-note"></a>
## 开发备注

无。
