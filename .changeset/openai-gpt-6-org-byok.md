---
"@mcpjam/inspector": patch
---

GPT-6.1 Sol, GPT-6 Sol and GPT-6 Astra are selectable on an organization's own OpenAI key.

They join GPT-6 Luna, which shipped in 3.21.1, so **Your providers** now offers
the whole GPT-6 family the hosted catalog serves, with the 1,050,000-token
context OpenAI documents. The four rows lead the OpenAI group.

On your own key they run on the Responses API, which GPT-6.1 Sol needs for tool
calling. Token counting maps the three new ids to GPT-5, the closest id
ai-tokenizer knows. The server's catalog lookup (`buildSyntheticModelDefinition`,
used by host-pinned evals and swarms) now reads them as OpenAI instead of
falling through to Ollama.

As on GPT-5, the temperature control is off for the four own-key GPT-6 rows,
GPT-6 Luna included. The AI SDK drops `temperature` at the default reasoning
effort, so a saved eval or swarm temperature on them is refused instead of
being recorded as applied. The hosted `openai/gpt-6-*` rows keep their
catalog's answer.
