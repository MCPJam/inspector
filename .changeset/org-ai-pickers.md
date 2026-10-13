---
"@mcpjam/inspector": minor
---

When an organization requires its own provider keys for AI features, every model picker (chat, eval targets, environments, the client builder and the judge) lists only the organization's eligible models: no "Free models" / "Your providers" tabs, no MCPJam models, no default judge, no personal keys or local runtimes. A model saved before the requirement stays selected and shows as a warning on the picker's button, by its name, and chat won't send with it until another model is chosen. With nothing to pick, admins are offered "Add a provider" and members are told to ask an organization admin. Pickers stay locked until the organization's AI settings have loaded. Organization models from a connection that can run AI requests directly can now be chosen as the eval judge.
