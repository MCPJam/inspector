---
"@mcpjam/inspector": patch
---

An omitted `temperature` reaches the provider omitted, and the model catalog
gets a say in whether the field is sent at all.

`prepareChatV2` substituted `0.7` for a `temperature` the caller did not send,
so "no preference" was indistinguishable from "0.7 please" by the time the
request left. It now passes through untouched. The chat tab always sends its
slider value, so nothing changes there; the callers this frees are the SDK, the
API and the eval runner, which previously had no way to ask for a provider's own
default sampling. The persisted `hostConfig.temperature` still lands numeric —
`buildDirectHostConfig` falls back to the requested value, then to `0.7` — so
transcript rows and hostConfig dedupe are unaffected.

`ModelDefinition` now carries `supportedParameters` from the hosted catalog DTO
(OpenRouter's `supported_parameters`), which the mapping had been dropping, and
`modelDefinitionSupportsTemperature` reads it. Hosted rows that report taking no
`temperature` lose the field without anyone adding their id to a list, which is
how the hardcoded `gpt-5` name stops being the only reasoning model handled.

Catalog metadata may only withdraw the field, never restore it: an affected
Anthropic family answers a 400 whatever a row claims, so the id predicate stays
authoritative for those. Absent or empty `supportedParameters` means "the
catalog said nothing" rather than "accepts nothing" — BYOK, org, Ollama and
custom rows never carry it, and reading empty as a denial would strip
temperature from every model behind a stale cache.

The temperature slider answers from the same predicate, so a model whose
catalog row withholds the field greys out instead of staying live over a value
the server goes on to drop.
