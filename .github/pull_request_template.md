## What this does

<!-- One paragraph. Why the change, not a narration of the diff. -->

## Deleted

<!-- Files, functions or paths this removes, or "Nothing". If a v2 lands here, name the v1 and when it goes. -->

## Reused

<!-- Existing helpers, components or modules this builds on instead of writing new ones, or "Nothing applicable". -->

## Production signal

<!-- The event, metric, log or alert that proves this works after deploy, or "None: not user-facing". -->

## Checklist

- [ ] I can explain every line of this diff without the agent that wrote it.
- [ ] Under 400 hand-written changed lines, or labelled `large-pr` / `mechanical`.
- [ ] No new `as any`, empty `catch`, `.catch(() => {})` or raw `console` on the server.
- [ ] Comments say why the code is this way, not how it got here.
