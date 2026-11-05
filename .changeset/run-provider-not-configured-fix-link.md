---
"@mcpjam/inspector": patch
---

When an eval's model provider isn't turned on for the organization, the run's error summary now groups those results under "An organization admin needs to add or reconnect an AI provider" and offers admins Manage AI providers, instead of "The cause wasn't recorded". The iteration's error reads "Unavailable: add an organization provider" instead of "Connection error". On a first-party hosted provider (Anthropic, OpenAI, Google and the like), such a result is now recorded as a configuration error, like a missing organization connection, so it no longer counts as a failed test in the run's pass rate. On a customer-hosted endpoint (Azure, Bedrock, Ollama or a custom provider) it still counts, as a missing connection does.
