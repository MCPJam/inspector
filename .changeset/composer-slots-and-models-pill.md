---
"@mcpjam/inspector": minor
---

The environment composer's lego strip is now a configurable set of slots, and gains a model pill.

The strip was a fixed sequence — environments, clients, servers, skills, sandbox — which is right for Swarm and User Testing but wrong for the new create-suite page, where a single step wants servers alone or clients plus a model. `EnvironmentComposer` takes an optional `slots` list; **omitting it reproduces today's strip exactly**, so no existing surface changes. Flag-gated slots named in the list still hide when their flag is off, so `slots` narrows what a surface asks for and never widens what a deployment allows. The "collapse to edit" hint is likewise scoped to strips that actually render the environments picker, where it was previously naming a control a caller could have omitted.

**`ModelsPill` is the new slot** — same dashed-pill-and-popover language as the others, single-select, closing on pick. `EnvironmentStack.modelId` changes from a reserved `undefined` placeholder to a real `string | null`. It is honestly half-wired and says so: surfaces can now carry a model through the shared stack instead of forking the strip, but **the resolver still ignores the field** — environments continue to resolve through the host plus the shared slots, and a null model means "use the selected client's own model", which is what every surface does today. New Swarm omits the slot entirely.

`ServerGroupPicker` accepts `triggerTestId` and `triggerAriaLabel` so composer-rendered instances are addressable, and the composer's empty-state label and info tooltip for the servers slot are now caller-supplied — the defaults are the strings that were hardcoded.
