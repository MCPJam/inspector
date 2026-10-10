---
"@mcpjam/sdk": minor
"@mcpjam/cli": minor
"@mcpjam/inspector": minor
---

Support organizations that require their own provider keys for every AI feature. Organization admins get a "Use your keys for all AI features" setting and default model roles (Fast, Smart, Embedding, Transcription) under AI providers, with per-feature coverage. While the setting is on, model pickers offer only eligible organization models, and runs, analysis and chat that can't use one say so ("Unavailable — add or configure an organization provider") instead of failing generically. The SDK error describer, model lease classifier and suite runner recognize the new refusal codes (new `AI_POLICY_REFUSED` error code and `orgPolicy` refusal), and `mcpjam eval run` exits 2 for a configuration refusal and 4 for a temporary one.
