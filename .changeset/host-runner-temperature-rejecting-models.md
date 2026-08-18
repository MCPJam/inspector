---
"@mcpjam/sdk": minor
"@mcpjam/inspector": patch
---

`HostRunner` no longer sends `temperature` to models that reject the field.

Anthropic removed the sampling parameters starting with Opus 4.7: `temperature`
(and `top_p` / `top_k`) answer a 400 on Opus 4.7 and later, Sonnet 5, Fable 5,
and Mythos 5, rather than being ignored. Earlier families still accept them.
`HostRunner` spread `temperature` into every request whenever one was set, so a
host snapshot carrying the default was enough to fail the run outright. The key
is now omitted entirely for those models — absent, not `undefined`, since the
field being present at all is what fails.

Bedrock is where this was reported, by a user whose security team requires it,
but Bedrock is only the surface: it serves the same models over the same
request surface, so an inference profile for an affected family fails
identically to a direct-Anthropic call.

`modelRejectsTemperature` is the new export carrying that answer, from both
`@mcpjam/sdk` and `@mcpjam/sdk/browser`. It is a per-family "removed from this
version onward" threshold compared numerically, not a list of exact ids: the
removal is monotonic within a family, so an enumeration would silently regress
the moment Opus 4.9 ships. It recognizes one model under every id shape the
apps accept — hosted (`anthropic/claude-opus-4.7`), a Bedrock inference profile
(`us.anthropic.claude-opus-4-7-20260205-v1:0`), the inference-profile ARN that
embeds one, and bare (`claude-sonnet-5`). Haiku has no threshold entry, because
no released Haiku dropped the parameters.

An *application* inference profile or provisioned-throughput ARN is a known gap:
it names an opaque resource rather than a model, so an affected family behind
one still sends the field. Resolving that needs a Bedrock API call rather than a
string match.

The inspector's `modelSupportsTemperature` now answers from that same predicate
instead of its own id list, which recognized neither the Bedrock spellings nor
any version past the ones written down. Its two carve-outs are unchanged:
MCPJam-provided models keep their temperature, and own-provider GPT-5 ids still
lose it.
