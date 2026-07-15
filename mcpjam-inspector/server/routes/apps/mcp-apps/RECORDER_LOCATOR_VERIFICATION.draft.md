# DRAFT — Recorder locator robustness via generate-and-verify

**Status:** draft for review. **Owner to revise:** TL.
**Files:** `recorder-shim.ts` (`generateLocator`), `__tests__/recorder-shim.test.ts`.

## Problem

A recorded "Widget interaction check" step (click the cart "🛒") replayed but the
cart never opened, so the `view-cart` tool call never fired and the assertion
failed. The recorded locator was `text="🛒"`: the recorder fell through its
priority ladder (testId → role+name → text → CSS) to the visible-text rung and
captured the emoji. A bare-emoji/short-text locator is ambiguous — on replay it
can resolve to a different node than the one clicked.

## Rejected: the "interactive ancestor" heuristic (reverted)

First attempt (`403af6dbf`, reverted in `9d0cd4513`) walked up from the clicked
node to the nearest "interactive" element via a hardcoded list
(`button`/`a[href]`/`[role=button|link|menuitem|tab|option]`/`summary`/`[data-testid]`/`[aria-label]`/`[tabindex=0]`).
This **overfits**: it patches the cart shape, misses web components and
non-semantic clickable `<div>`s, and can climb to the wrong ancestor. It guesses
"is this interactive?" — a question with no clean general answer.

## Proposed: generate-and-verify (this draft)

Invariant that actually matters: **a recorded locator must deterministically
re-select the exact element it was generated from.** So make `generateLocator`
verify each candidate by resolving it back (`resolveLocator(candidate) === el`)
and accept only the first that uniquely lands on the element. The CSS-path rung
is built to be unique (it appends `nth`), so the ladder always terminates.

```
testId (+nth)            → unique by construction, kept as-is
role + accessible name   → accept ONLY if it round-trips to el, else fall through
visible text (≤80)       → accept ONLY if it round-trips to el, else fall through
CSS path (+nth)          → always unique → terminal
```

`text="🛒"` (and any duplicate/ambiguous role/text) now fails verification and
falls through to a unique CSS path that re-selects the precise node. No
element-type guessing; generalizes to every widget (duplicate text, nested
spans, icon buttons, custom elements).

`resolveLocator` mirrors the headless harness's `resolveScriptedLocator`, so a
candidate that round-trips in the recorder resolves identically at run time. This
draft does **not** change resolution semantics — only *which* candidate wins — so
**no harness change is required**.

## Backward compatibility

All pre-existing `generateLocator` / round-trip tests stay green (locators that
already uniquely round-trip are unchanged). New tests assert the general fix:
- duplicate-named `role+name` → rejected → emits a locator that re-selects the
  *correct* (second) element; the bare role locator provably mis-resolves.
- ambiguous `text` → same.
- unique `text` → still emitted as `text`.

## Open questions / refinements for the TL

1. **`nth` for role/text instead of straight fall-through.** Today an ambiguous
   role/text candidate drops to a CSS path. We could instead attach `nth` to the
   role/text candidate (compute the element's index among matches) and keep the
   readable locator. Requires `resolveLocator` **and** the harness's
   `resolveScriptedLocator` to honor `nth` for role/text (verify they do; the
   CSS/testId rungs already do). Trade-off: readability vs. a coordinated
   two-file change.
2. **CSS-path stability.** The fallback `nth-of-type` chain (capped at 5 levels)
   is unique at record time but can break across widget re-renders. Acceptable
   as a terminal, but worth a comment in the UI that testId/aria-labelled
   controls record the most durable locators.
3. **Document scope.** `roundTripsTo` calls `resolveLocator`, which reads the
   global `document`. In the guest and in jsdom tests that equals
   `el.ownerDocument`; if they ever differ, verification fails safe (falls to
   CSS). Consider threading `el.ownerDocument` through if multi-document is ever
   in play.
4. **Widget-side a11y.** The most durable fix is widgets exposing
   `data-testid`/`aria-label` on icon controls — recorder hardening only defends
   against their absence. Worth a docs/product note for app authors.

## Unconfirmed — separate possible cause

I inferred "locator" from the cart not opening, but did not confirm it. If a
re-recorded, **verified** locator still doesn't fire `view-cart`, the cause is
the other branch: the widget→host `view-cart` call lands **after** the harness's
per-step capture window (`drainAfterAction`, `settleTimeoutMs = 2000ms` in
`mcp-app-browser-harness.ts`) — the drain waits only for in-flight RPCs, not a
call dispatched on a post-click tick. That's a timing fix (post-click grace
period / widen the window), independent of this draft.

## How to verify this draft

1. Re-record the cart click (Record view-cart → click cart → save). Inspect the
   step's locator: it should no longer be `text="🛒"` when the click is
   ambiguous — it should be a CSS path (or role+name) that re-selects the cart.
2. Re-run → `view-cart` fires → step 6 green. If it still fails *with a verified
   locator*, pivot to the capture-window fix above.
3. `npx vitest run server/routes/apps/mcp-apps/__tests__/recorder-shim.test.ts`
   (31 green). Restart the inspector server so the injected `RECORDER_SHIM_JS`
   picks up the change before re-recording.
