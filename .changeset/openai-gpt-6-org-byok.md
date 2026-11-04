---
"@mcpjam/inspector": patch
---

GPT-6 is selectable on an organization's own OpenAI key.

The organization (and BYOK) OpenAI rows are hand-maintained and had stopped at
GPT-5.6 while the hosted catalog was already serving `gpt-6.1-sol`,
`gpt-6-luna`, `gpt-6-sol` and `gpt-6-astra`, so an organization that connected
its own OpenAI key got an older model choice than MCPJam's own inference. All
four now lead the OpenAI group under **Your providers**, with the 1,050,000-token
context OpenAI documents.

On your own key they run on the Responses API, which GPT-6.1 Sol needs for tool
calling. Token counting maps the four ids, bare or `openai/`-prefixed, to GPT-5,
the closest id ai-tokenizer knows. The server's catalog lookup
(`buildSyntheticModelDefinition`, used by host-pinned evals and swarms) now
reads these bare ids as OpenAI instead of falling through to Ollama.
