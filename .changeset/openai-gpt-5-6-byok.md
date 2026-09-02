---
"@mcpjam/inspector": patch
---

GPT-5.6 is selectable with your own OpenAI key.

The BYOK OpenAI rows are hand-maintained and had stopped at GPT-5.1 while the
hosted catalog was already serving `gpt-5.6-luna`, `-sol` and `-terra`, so a
user with a valid key could not pick the models MCPJam already serves for free.
All three now lead the OpenAI group, with the 1,050,000-token context the
catalog reports.

Token counting maps them to GPT-5, the closest id ai-tokenizer knows; an
approximate count beats dropping to the character-based fallback. Temperature
needed no new handling — the `gpt-5` carve-out in `modelSupportsTemperature`
already matches these ids, so the field is omitted rather than sent.
