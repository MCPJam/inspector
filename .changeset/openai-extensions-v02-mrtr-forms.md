---
"@mcpjam/inspector": patch
"@mcpjam/sdk": patch
---

OpenAI extended forms work over MCP 2026-07-28 (MRTR): the ChatGPT and Codex clients advertise `extensions["openai/elicitation"]` alongside form elicitation, and a form's schema is read from `_meta["openai/elicitation"].requestedSchema` everywhere it is shown, bound and validated. A form whose extension schema is missing or invalid is refused with a described error instead of appearing empty.

SDK: `setMrtrInputCollector` takes `extensionClaims` and `selectFormSchema`, and `runInputRequiredOperation` takes `selectFormSchema`, so an answer collected in-process is validated against the schema the form showed. A collector's extension claims are withheld on 2026-07-28 connections that don't drive MRTR rounds (`supportsMrtr: false`).
