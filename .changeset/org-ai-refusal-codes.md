---
"@mcpjam/sdk": minor
"@mcpjam/cli": minor
---

Recognize the refusal codes MCPJam sends when an organization requires its own provider keys for AI features. The SDK error describer maps them to new `org/*` catalog entries (new `orgPolicySlugForCode` and `OrgPolicyRefusalCode` exports), directory-readiness observations accept the `platform_cap_reached` and `ai_unavailable` reasons, and `mcpjam eval run` exits 2 for a configuration refusal and 4 for a temporary one.
