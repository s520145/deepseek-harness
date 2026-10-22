---
kind: upgrade-guide
description: "基础 profile 自动续接输出截断，并保留旧版读取器会拒绝的工具派发收据。"
---

# 有界输出续接

[English](guide.md) | 中文

## 变更

基础 profile 每轮最多自动续接两次被截断的响应。恢复成功后，轮次以实际结果结束，并在 Session 中保留先前的截断记录。恢复期间会拒绝完全相同的工具调用，包括结果不确定的调用；调用方不能依赖自动重复这些操作。

没有原生或 PTC 开始记录的直接执行器调用，以及自动恢复期间派发的每个工具调用，都会新增 `output-continuation/tool-dispatched` 摘要收据。这些收据不包含参数，是重载后安全恢复所必需的数据。旧版读取器会在恢复或改写前拒绝含有此未知必读事件的 Session。Session 格式版本保持不变；持久化变更确认记录说明读取兼容性。

## 迁移

1. 保持基础组合的 `output-continuation` 项启用以使用有界恢复。需要保留手动续接时，在 profile patch 中将该项的 `config.maxContinuations` 设为 `0`。`1` 到 `10` 的值设置每轮上限。
2. 打开含派发收据的 Session 时，保留能够识别 `output-continuation/tool-dispatched` 的构建。不要删除事件或编辑历史 Session 文件来强制降级。
3. 验证自动续接通知已保留，恢复成功后以 `completed` 结束，且默认上限下第三次连续截断以 `max-tokens` 结束，不再发起请求。普通完成、取消和限流不会触发自动输出续接。
