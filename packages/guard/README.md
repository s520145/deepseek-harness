---
description: "Package map for bounded output continuation, advisory repeat-tool reminders, and per-tool-call timeout policies."
kind: "package-group"
---

# guard/ — loop-hygiene guard family

English | [中文](README.zh.md)

## Summary

The `guard/` plugins keep tasks moving when output is truncated, tools repeat, or calls stall. `output-continuation` resumes truncated output within a configured limit and denies identical tool calls during recovery. `repeat-tool-reminder` asks the model to change approach after repeated calls. `timeout-policy` returns an error when a declared tool timeout expires. All ship enabled in the base bundle and can be configured or removed.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

Each plugin covers one failure pattern; each README below explains when to keep, tune, or remove it.

| Package | What it provides |
|---|---|
| [`output-continuation/`](output-continuation/README.md) | Resumes truncated output with bounded attempts and repeated-call protection |
| [`repeat-tool-reminder/`](repeat-tool-reminder/README.md) | Reminds the model when it repeats the same tool call, so it changes approach or finishes |
| [`timeout-policy/`](timeout-policy/README.md) | Times out tool calls that declare a limit, so the model gets a clear error instead of waiting forever |

-----

<a id="related-documentation"></a>
## Related documentation

Start with the tools subsystem reference for the tool-call pipeline, then the reminder's configuration and the timeout-library decision behind the policy.

- [Tools subsystem reference](../../docs/subsystems/tools.md) — the tool-call pipeline and decisions guards use.
- [Generated configuration catalog](../../docs/config-catalog.md#deepseek-aidsh-repeat-tool-reminder) — every accepted field of the repeat-call reminder.
- [Timeout deadline library Agent Note](../../.agents/notes/implemented/architecture/2026-07-06-timeout-deadline-library.md) — the timing/termination split `timeout-policy` enforces.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
