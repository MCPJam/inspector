---
"@mcpjam/inspector": patch
---

Hosted Claude models that reject `temperature` no longer carry one.

`modelSupportsTemperature` exempted MCPJam-provided ids on the grounds that the
backend owns the request body it sends upstream. It does not strip the field —
it substitutes `0.7` for a non-numeric one — so a hosted id in an affected
family sent a sampling parameter Anthropic answers with a 400, and failed on its
first hosted turn. A hosted id now answers the same as the model it names.

Which models reject the field is a per-family version threshold rather than a
list of ids: Opus 4.7 and later, Sonnet 5 and later, Fable 5 and later, and
Mythos 5 and later, with any family that has no threshold of its own held to 5.
Every shipped Haiku is below that and keeps its temperature. In the current
hosted catalog the threshold covers `anthropic/claude-opus-4.7`,
`anthropic/claude-opus-4.8`, `anthropic/claude-sonnet-5` and
`anthropic/claude-fable-5` — the field is omitted from their `/stream` body and
the temperature slider greys out for those rows. A later release in an affected
family, or a hosted `anthropic/claude-mythos-5` row, is covered by the same
threshold with no code change.

This is the half the inspector owns: the backend still has to stop defaulting
`temperature` for those models, or the value it substitutes fails the request on
its own. Tracked separately; nothing else in the hosted payload changes, and
`hostConfig.temperature` stays numeric because chat ingestion falls back to the
requested value.

The GPT-5 carve-out is unchanged in effect but now also applies to hosted
`openai/gpt-5*` ids, which the exemption had been shadowing.
