---
"@mcpjam/inspector": minor
"@mcpjam/sdk": patch
---

Organization → AI providers gains a "Default AI model" card under the AI keys card. While "Use your keys for all AI features" is on, work nobody picks a model for (insights and findings, generation, typed decisions, simulated users) runs on this organization model; until an admin chooses one, that work is unavailable. Admins choose it from the organization's eligible providers that can run it, can apply MCPJam's suggestion with one click (it is never applied on its own), test it, and clear it; each row shows the last test's result and time. Like the switch, it is available on Enterprise plans, and a model saved before an organization left Enterprise stays visible and can be cleared. Members see it read-only. Model pickers never use it, and each suite still chooses its own judge. The AI keys card's feature coverage now says when a feature is waiting for the default model, and the billing page, error-code docs and SDK error hints say that Swarm and other background AI run on it.
