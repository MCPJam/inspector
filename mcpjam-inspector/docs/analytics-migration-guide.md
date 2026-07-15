# Migrating raw `posthog.capture()` to `track()` (analytics registry)

Turnkey guide for the incremental migration behind the ratchet fence. This is
**coverage-neutral** — it changes how events are *called*, not whether they
fire — so it's safe, mechanical, area-by-area work. Good first issue.

## Why

~75 files still call `posthog.capture("free-string", …)` directly. The typed
registry (`shared/analytics-events.ts`) + `track()` wrapper
(`client/src/lib/analytics.ts`) give: one authoritative list of every event,
compile-time checking of names, auto-injected standard props, and a client
that can't emit server-authoritative events. The ratchet test
(`client/src/lib/__tests__/analytics-ratchet.test.ts`) freezes the legacy
files: no *new* file may add a raw capture, and migrating a file requires
removing it from the list.

## Per-file recipe

1. **Register the events.** Add each event name this file fires to
   `shared/analytics-events.ts` with `{ source: "client" }`.
2. **Swap the import.** Remove `usePostHog` from `posthog-js/react` and
   `standardEventProps` from `@/lib/PosthogUtils`; add
   `import { track } from "@/lib/analytics"`.
3. **Delete `const posthog = usePostHog()`.**
4. **Convert each call:**
   ```ts
   // before
   posthog?.capture("skill_viewed", { ...standardEventProps("skills_tab"), skill_name });
   // after
   track("skill_viewed", { location: "skills_tab", skill_name });
   ```
   - `track()` injects `standardEventProps(location)` for you — pass `location`
     as a prop, drop the spread.
   - For calls that **don't** currently include `standardEventProps` (some
     areas omit it — e.g. `PaymentsHistorySection`, `useCreditTopup`), pick a
     sensible `location` string. This *adds* `platform`/`environment` to those
     events — a deliberate, beneficial consistency improvement; note it in the
     PR since it slightly changes the event shape.
5. **Remove the file from `LEGACY_RAW_CAPTURE_FILES`** in the ratchet test.
6. **Update any test that mocks `usePostHog`** for this file: mock
   `@/lib/analytics`'s `track` instead and assert on it. Pattern in
   `client/src/lib/__tests__/analytics.test.ts`.
7. Run `npx vitest run --project client src/lib/__tests__/analytics-ratchet.test.ts`
   — it fails loudly if the file still has a raw capture or the list is stale.

## Reference migration

`client/src/components/SkillsTab.tsx` (commit in #3096) — the canonical
example: three calls converted, no test coupling.

## Special cases (do last / discuss first)

- **Dynamic event names** — `logger-view.tsx:365`,
  `shared/ClientContextHeader.tsx:151`, `MultiHostPicker.tsx:212` wrap
  `useCallback((event, props) => …)` with a runtime event string. `track()`
  needs a statically-known name, so these need the names hoisted to constants
  or a small typed dispatcher. Not a straight swap.
- **`posthogRef.current.capture`** — `hosted/ChatboxChatPage.tsx` holds a ref;
  migrate the ref usage to `track()` directly (the singleton is fine).

## Suggested order (funnel-first)

1. `billing/` + `useCreditTopup*` — revenue events (7 events).
2. `signup/OccupationGate.tsx`, `auth/auth-upper-area.tsx`, `use-onboarding.ts`
   — activation funnel.
3. `ChatTabV2.tsx`, `ui-playground/PlaygroundMain.tsx` — chat funnel (pairs
   with the server twins).
4. Everything else, area by area.

The full frozen list is `LEGACY_RAW_CAPTURE_FILES` in the ratchet test.
