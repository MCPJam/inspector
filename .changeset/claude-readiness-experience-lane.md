---
"@mcpjam/sdk": minor
---

Claude readiness: the experience-insights lane gets checks, including the ones
a browser would run.

Seven new checks, and **not one of them can move a verdict**. They are all
`heuristic` or `manual-review`, and `decideLaneStatus` reads neither — that is
not a convention to be careful about, it is what makes it safe to ship checks
whose evidence is suggestive rather than dispositive. A run-level test grades a
connector that trips every one of them at once and asserts it is still `ready`.

**Why these are advisory and the others are not.** Anthropic publishes no
maximum tool count and no minimum description length, and there is no threshold
at which a connector becomes un-listable for either. What there *is* is a
well-understood failure mode: a model choosing between forty near-identically
named tools picks wrong, and the person blames the connector. Saying that out
loud is useful; turning it into a pass/fail would be inventing policy Anthropic
never wrote, which is exactly what the finding-class vocabulary exists to
prevent. The thresholds live in `CLAUDE_EXPERIENCE_BUDGETS` and the
remediations say "beyond about N", because the number is ours.

From the tool listing:

- **Descriptions that say more than the name.** Claude picks tools by reading
  them, so a name-shaped description is the one it will pick wrongly. Aimed at
  placeholders — terse but real prose passes, because flagging it would train
  people to pad.
- **Names that collapse to the same string.** `get_user` and `getUser` differ
  by punctuation a model does not reliably distinguish. Case and separators
  only: `get_user` and `fetch_user` are two names a reader tells apart, and
  flagging those would bury the pair that genuinely collide.
- **Tool surface size**, reported as `informational` even over budget.
- **Required string parameters with nothing to go on.** An `enum`, a `format`,
  a `pattern`, an example or a description all give the model something; only a
  bare `{"type": "string"}` leaves it inventing a value.

From a browser, when there is one:

- Console errors on render, layout that overflows Claude's narrowest surface,
  and a widget that paints nothing.

**The browser checks are defined now, before a harness exists, on purpose.**
They carry `requiresCapabilities: ["browser"]`, so every wire-only run reports
them as `not-evaluated` and counts them in the lane's coverage. A lane that
silently omitted them would report as fully covered, and "we did not look"
would be indistinguishable from "there was nothing to see" — the one thing this
result model exists to keep apart.

Three different reasons for not evaluating them, because the capability gate
deliberately will not overwrite a reason already written: no browser at all; a
browser that reported nothing (a harness failure, said as one, so a submitter
does not debug their widget over our problem); and a widget whose width was
never measured, which is never read as fitting.

A blank widget is `informational` on a `manual-review` check rather than
`violated`: it may be broken, or it may be correctly waiting for data the
harness never supplied, and a machine cannot tell those apart.
