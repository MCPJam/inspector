---
"@mcpjam/inspector": patch
---

When an eval's model provider isn't turned on for the organization, the run's error summary now says the organization's AI provider settings stopped the run and offers Manage AI providers (or tells a member to ask an admin), instead of "The cause wasn't recorded". The iteration's error reads "Unavailable: add an organization provider" instead of "Connection error".
