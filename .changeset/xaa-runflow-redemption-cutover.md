---
"@mcpjam/sdk": patch
---

Route the CLI `runXaaFlow` redemption through the shared `createInProcessXaaExecutor` `/proxy/token` route — the exact seam the XAA state machine drives — instead of inlining the jwt-bearer request + OAuth proxy call. The CLI and the shared engine now redeem ID-JAGs through one path. The public `runXaaFlow`/`XaaFlowConfig`/`XaaFlowResult` contract is unchanged and all 22 `run-xaa-flow` contract tests pass unchanged (byte-equivalent output). The remaining full state-machine drive (mint + MCP call + discovery through the engine) is a follow-up gated on candidate-order equivalence.
