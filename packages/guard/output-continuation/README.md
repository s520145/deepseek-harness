---
description: "Bounded automatic output-limit continuation and conservative duplicate-tool protection."
kind: "package-reference"
---

# @deepseek-ai/dsh-output-continuation

English | [中文](README.zh.md)

## Summary

Continues a task when the latest structured model outcome is `max-tokens`. The default permits two automatic next steps per turn, including turns with many intervening successful tool steps. Normal stops, errors, rate limits, and cancellation do not trigger continuation. Model budgets remain unchanged.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Use this package

The base bundle enables the plugin. Configure `maxContinuations` as an integer from 0 through 10; the default is 2, and 0 disables automatic continuation and its tool guard. Invalid values fail plugin loading.

```yaml
- name: '@deepseek-ai/dsh-output-continuation'
  config:
    maxContinuations: 2
```

A queued human next-turn or next-step input takes precedence and ends automatic continuation for the current turn. Cancellation removes this plugin's pending input even when other inbox items are retained. Each automatic input has its own durable receipt; removing an input or reloading the plugin does not replenish that turn's budget. The final allowed continuation asks the model to finish concisely or hand remaining work to the user. A further output limit ends the turn normally as `max-tokens`.

## Understand the implementation

The plugin contributes a host-only `outputContinuation` Session Projection. It incrementally folds the open turn, latest assistant outcome, issued input identities, and tool-attempt identities. Issued inputs are deduplicated by message id across inbox insertion and admitted user-message events. Each source carries `turn`, `triggerAssistantSeq`, and `attempt`; ended turns cannot admit old inputs after resume or hot reload.

At `agent/turn-stopping`, a current, uncancelled output-limit outcome queues one non-waking next-step input. `agent/pre-step` delegates to downstream policy and only sets `resumesAfterMaxTokens` when the final admitted messages contain that valid input. The core loop owns the resulting turn-end transition. Normal model history remains intact, and tool fragments from the truncated stream are never replayed or dispatched by this package.

After an automatic input is admitted, `tools.guard` denies repeated tool names with the same complete JSON arguments from that turn. Object-key order is normalized; array order and values remain significant. The projection retains SHA-256 identity digests rather than duplicating argument bodies. The current native or PTC-start record is excluded from its own duplicate check; earlier same-batch calls and nested PTC dispatches participate. Before the first automatic continuation, otherwise unlogged direct executor calls append `output-continuation/tool-dispatched` before dispatch. During automatic continuation, every actual dispatch appends this receipt, so in-flight protection survives hot reload even when a caller reuses a call id. A receipt means the body may have run; it is never excluded as the current call. This required audit event carries only the turn, call id, and identity digest; it does not enter model context. Older readers that do not recognize it refuse session admission. All tools participate, including concurrency-safe tools. No prior result is substituted for a denied call.

An earlier recorded call with an unknown outcome is treated as potentially executed. This deliberately also rejects repeats of previously denied calls: the guard does not infer absence of side effects from a generic error result. The guard ends on human input or the turn boundary. Registrations belong to the plugin instance; durable receipts and call identities rebuild through the projection.

## Further Exploration

- [Agent loop](../../core/agent-loop/README.md) owns input admission, step execution, and turn endings.
- [Tools subsystem](../../../docs/subsystems/tools.md) defines the executor guard and nested PTC dispatch.
- [Session Projection](../../session/session-projection/README.md) owns incremental replay and persisted-cache validation.

## Model Experience

### Automatic continuation input

#### What the model sees

After an eligible output limit, the model receives this notice. `{attempt}` and `{limit}` are integers. The penultimate line is replaced by the final-attempt text below on the last allowed input.

##### Continuation notice

```markdown
Your previous response reached its output limit. Continue the unfinished task from the recorded history. This is automatic continuation {attempt} of {limit} for this turn.
Keep completed work and recorded tool results; do not repeat tool calls that already ran or may have run. Tool calls in the truncated response were not executed; issue any still-needed calls again with complete arguments. Do not reconstruct or execute partial tool arguments.
Continue concisely and finish when the task is complete.
Exact repeated tool calls are blocked during automatic continuation, including calls whose earlier outcome is uncertain. Different arguments do not guarantee that a repeated side effect is safe.
```

##### Final-attempt text

```markdown
This is the last automatic continuation. Finish concisely if possible; otherwise explain the remaining work and ask the user to continue.
```

#### Token effect

Adds one retained notice and one normal model request per admitted continuation, bounded by the configured same-turn count. Intervening tool steps can add their usual requests and results. This package neither raises output budgets nor changes compaction thresholds.

#### KV Cache effect

Notices append after existing history and preserve an otherwise reusable prefix. Plugin reload reconstructs receipts without rewriting model history. Provider cache availability remains outside this package.

### Duplicate-call denial

#### What the model sees

The tool executor returns an error instead of invoking the duplicate operation:

##### Denial result

```markdown
Error: Automatic continuation blocked an identical tool call that already ran or may have run in this turn. Inspect the recorded result and continue without repeating that operation. No previous success result has been substituted.
```

#### Token effect

Adds the standard tool error result for each denied native call. Nested PTC denials reach the program through its ordinary tool error path; the enclosing program's result determines its model-visible content. No argument body is quoted by the guard.

#### KV Cache effect

Native denial results append to existing history. The guard adds no tool schemas, replaces no prior result, and preserves an otherwise reusable prefix.

## Known Limitations and Deferred Work

- Different arguments can describe the same side effect; canonical identity does not provide semantic deduplication or exactly-once execution.
- Generic error results cannot prove that an operation never ran. Conservatively blocking their identical repeats may require human intervention.
- A truncated response may contain only reasoning or an unfinished tool call. Continuation preserves available history and does not promise recovery of missing arguments or hidden provider state.
- The count bounds automatic continuation inputs, not the number of ordinary tool steps or total tokens in a turn.

<a id="dev-note"></a>
### Dev Note

None.
