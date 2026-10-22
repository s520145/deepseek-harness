---
kind: upgrade-guide
description: "Base profiles automatically continue output truncation and preserve tool-dispatch receipts that older readers refuse."
---

# Bounded output continuation

English | [中文](guide.zh.md)

## Change

Base profiles automatically continue a truncated response up to twice per turn. Successful recovery ends with its actual outcome while retaining the earlier truncation in the Session. During recovery, identical tool calls are denied, including calls with uncertain outcomes; callers must not depend on repeating them automatically.

Direct executor calls without native or PTC start records, and every tool dispatched during automatic recovery, add `output-continuation/tool-dispatched` digest receipts. These receipts contain no arguments and are required for safe recovery after reload. Older readers refuse Sessions containing this unknown required event before resuming or rewriting them. The Session format version remains unchanged; the persistence acknowledgement documents reader compatibility.

## Migration

1. Keep the `output-continuation` base row enabled for bounded recovery. To retain manual continuation, set that row's `config.maxContinuations` to `0` in the profile patch. A value from `1` through `10` sets the per-turn limit.
2. Keep a build that understands `output-continuation/tool-dispatched` when opening Sessions containing dispatch receipts. Do not remove events or edit historical Session files to force a downgrade.
3. Verify that automatic notices are retained, successful recovery ends as `completed`, and a third consecutive truncation with the default limit ends as `max-tokens` without another request. Ordinary completion, cancellation, and rate limits do not request automatic output continuation.
