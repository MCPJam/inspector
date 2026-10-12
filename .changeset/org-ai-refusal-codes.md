---
"@mcpjam/sdk": minor
"@mcpjam/cli": minor
---

Recognize the refusal codes MCPJam sends when an organization requires its own provider keys for AI features. The SDK exports the codes and how each is handled (`AI_EXECUTION_REFUSAL_CODES`, `AI_REUSED_REFUSAL_CODES`, `AI_REFUSAL_CODES`, `AI_CONFIGURATION_REFUSAL_CODES`, `AI_RETRYABLE_REFUSAL_CODES`, `aiRefusalClass`, `recognizedAiRefusalCode`, `isAiExecutionRefusalCode` and the `AiRefusalCode`, `AiExecutionRefusalCode` and `AiRefusalClass` types), and its error describer maps them to new `org/*` catalog entries (new `orgPolicySlugForCode` export). Directory-readiness observations accept the `platform_cap_reached` and `ai_unavailable` reasons, and `mcpjam eval run` exits 2 for a configuration refusal and 4 for a temporary one.
