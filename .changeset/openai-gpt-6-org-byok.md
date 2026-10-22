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

They run on the Responses API, which GPT-6.1 Sol needs for tool calling, and
`temperature` is no longer sent for them: they are reasoning models that only
sample at reasoning effort `none`, which nothing sends. Token counting maps them
to GPT-5, the closest id ai-tokenizer knows. A host or eval case pinned to one of
these bare ids is now read as OpenAI instead of falling through to Ollama.
