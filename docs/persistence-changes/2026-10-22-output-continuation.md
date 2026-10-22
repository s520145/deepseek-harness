---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-22-output-continuation

English | [中文](2026-10-22-output-continuation.zh.md)

## Summary

Adds durable output-continuation ownership markers and required tool-dispatch digest receipts for bounded recovery.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

Existing records remain valid. Message sources are merge-extensible context notices; readers preserve unfamiliar producer kinds. Dispatch digest receipts are log-only required events: older readers lacking the discriminator reject affected Sessions before resume, append, or tail repair. This safe refusal keeps the current Session format version; no committed generations are rewritten. The new reader rebuilds counters and dispatch identities from mixed native, PTC, and digest records.

<a id="verification"></a>
## Verification

28 output-continuation runtime tests and 2 real Loader tests passed; 82 AgentLoop tests passed. 36 persistence admission/source tests passed, including unknown required-event refusal before read/write mutation and preservation of source bytes.

<a id="dev-note"></a>
## Dev Note

None.
