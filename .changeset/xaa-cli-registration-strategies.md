---
"@mcpjam/sdk": minor
"@mcpjam/cli": minor
---

`mcpjam xaa run` can now select the client-registration strategy: `--registration <preregistered|dcr|cimd>` (plus `--client-metadata-url` for CIMD). Previously the headless XAA flow was hardcoded to pre-registered even though the shared state machine already implemented all three strategies.

- **SDK**: `XaaFlowConfig` gains optional `registrationStrategy` and `clientIdMetadataUrl`, and `clientId` becomes optional. `runXaaFlow` threads the strategy through the existing state machine and shares ONE internal DCR credential cache across the valid/baseline/probe attempts, so a run performs a single dynamic registration and reuses it. `XaaFlowResult` gains a secret-free `registration` diagnostic (`strategy`, `clientId`, `reused`, `warnings`) — the DCR-minted `client_secret` never enters the result. The CIMD metadata-document URL is now configurable (`BaseXAAStateMachineConfig.clientIdMetadataUrl`), defaulting to the hosted XAA document and validated without normalization.
- **CLI**: `--client-id` is required only for `preregistered`; `--client-id`/`--client-secret`/`--token-endpoint-auth-method` are rejected for `dcr`/`cimd` (the identity and auth method are derived). `--token-endpoint` is rejected for dcr/cimd (it skips the AS-metadata discovery those strategies need); `--authz-server-issuer` stays valid. Registration diagnostics — including the public-client CIMD warning — are surfaced in the result and preserved through output redaction.

DCR works end-to-end against a confidential-client RAS. CIMD here is the public-client variant (`token_endpoint_auth_method: none`); a RAS that requires `private_key_jwt` will reject it, so confidential CIMD remains a follow-up.
