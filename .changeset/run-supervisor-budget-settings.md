---
"@mcpjam/inspector": minor
---

Execution budgets are now authorable on a suite, from the settings page and over the API.

Until now every run resolved the platform defaults, because there was nowhere to say otherwise: the contract, the ladder and the runtime all landed first, and the number a person would type had no home. A suite can now author five clocks — per turn, per tool call, per iteration, whole run, and how many times one model call is retried — and they travel the same path the resolver already understood, so an authored suite and a defaulted one differ only in which rung each field came from.

**Un-authored is not zero, and the surface says so.** An empty field shows the platform default it inherits rather than a blank, because "no value" here means "whatever the platform decides", and a reader who cannot tell inheritance from a choice cannot tell whether anybody has thought about the number. A cleared field saves as `null`, which resets to the default; omitting it would silently keep the budget just deleted. The same distinction runs through the change ledger, where an un-authored clock reads "Platform default" instead of a number nobody chose.

**The five clocks are five rows but one stored object**, and that asymmetry is deliberate on both sides. Five rows, because a dirty badge that named "budgets" would light up for a clock the reader did not touch. One object, because the mutation replaces `executionBudgets` rather than merging into it — so a save assembles all five from the draft, and editing one clock never clears the four beside it. A test pins exactly that.

The API takes them at `settings.executionBudgets.*` on the suite PATCH, validated by the canonical schema from `@mcpjam/sdk/contract` rather than a restatement of it. That matters more than it sounds: each field's `max` in that schema IS the platform ceiling, so a value the platform could never run is refused by parsing, before the ladder is consulted. A second copy of those bounds in the route would be a second place for them to drift.

**Both** platform bounds come from that schema, not just the ceiling. Every clock has a real floor too — a tool call may not be given under a second, an iteration under thirty — and a table carrying only the ceiling would let the form offer a `0` the server was always going to refuse, which is reachable here precisely because an authored `0` is a real value rather than a way of spelling "unset".

Those are the PLATFORM bounds only. An organization that lowered its own ceiling is enforced by the server, which refuses the save naming the field and the bound — the same refuse-don't-clamp rule the resolver follows. Pre-empting that in the form would need the effective ceiling, which suite capabilities do not carry yet.
