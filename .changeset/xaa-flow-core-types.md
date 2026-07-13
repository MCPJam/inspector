---
"@mcpjam/sdk": minor
---

Move the XAA flow-core types and AS-compatibility preflight into the SDK (`xaa/state-machines/{types,capability-preflight}.ts`), exported from `@mcpjam/sdk/browser`. This includes the injected `XAARequestExecutor` seam, `XAAFlowState`/`XAAFlowStep`, `BaseXAAStateMachineConfig`, `XAAStateMachine`, DCR credential-cache types, `EMPTY_XAA_FLOW_STATE`/`createInitialXAAFlowState`, and `analyzeAsCompatibility`/`detectVendor`. The inspector's hosted test-bench resource-app types stay client-owned; the client modules become thin re-export shims. Prepares the shared state-machine move.
