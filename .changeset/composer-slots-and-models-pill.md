---
"@mcpjam/inspector": minor
---

The environment composer's lego strip is now a configurable set of slots, and gains a model pill.

The strip was a fixed sequence — environments, clients, servers, skills, sandbox — which is right for Swarm and User Testing but wrong for the new create-suite page, where a single step wants servers alone or clients plus a model. `EnvironmentComposer` takes an optional `slots` list; **omitting it reproduces today's strip exactly**, so no existing surface changes. Every pill now consults it — previously only the models pill did, so a caller that passed `slots` still got the whole strip. Flag-gated slots named in the list still hide when their flag is off, so `slots` narrows what a surface asks for and never widens what a deployment allows. The "collapse to edit" hint is likewise scoped to strips that actually render the environments picker, where it was previously naming a control a caller could have omitted.

**`ModelsPill` is the slot evals opts into**, carrying the stack's `modelSelection` axis (`includeClientDefaults` plus explicit ids) rather than a single id — the model is a fan-out axis, so a surface can ask for the client default *and* two overrides and get a cell per combination. It is capability-gated as well as slot-gated: without the backend model matrix the pill stays hidden, and the resolver refuses to send a model it cannot represent. New Swarm and User Testing omit the slot entirely so a model-bearing environment cannot silently shed its override.

Surfaces must **not** seed a host's default `modelId` as an explicit pick. The default selection already means "run the client's own model"; an explicit id that happens to equal the default fingerprints as a distinct environment and mints a duplicate ad-hoc row.

`ServerGroupPicker` accepts `triggerTestId` and `triggerAriaLabel` so composer-rendered instances are addressable, and the composer passes them through. The composer's empty-state label and info tooltip for the servers slot are now caller-supplied — the defaults are the strings that were hardcoded, which describe an *optional* group; a surface that makes the group required has to say so itself rather than offering "client default" for a choice it will then block on.
