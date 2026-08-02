# Feature-flag defaults audit (ACR-6)

Part of the analytics-capture-resilience project. When PostHog's `/flags`
endpoint is unreachable, `useFeatureFlagEnabled(flag)` returns `undefined`,
and every gate in the app resolves that to "off." This audits what each gate
does in the blocked/unresolved state and whether that default is safe.

## The blocked state is now rare

Before the relay, ad blockers blocked `/decide` at `us.i.posthog.com`, so
for ~25–40% of web users **every** flag stayed `undefined` and all gated
surfaces silently disappeared. Since the relay landed (#3095), `/flags`
resolves same-origin and is no longer ad-blockable, so the blocked state is
now limited to genuine network failure or the brief first-paint window before
the flag response returns. The guest-bootstrap change (#3098) further shrinks
that window. So the defaults below are mostly a **first-paint-flicker**
concern now, not a "blocked user loses the feature" concern.

## Default behavior: fail-closed everywhere

Every gate resolves `undefined` → **hidden/off**. Two shapes:

- **Boolean gates** (`useFeatureFlagEnabled(flag) === true`): hidden until the
  flag resolves `true`. The dominant pattern.
- **Tri-state hooks** (`useSkillsEnabledState`, `useComputersEnabledState`):
  return `boolean | undefined` so route guards can tell "explicitly disabled"
  from "not yet resolved" and avoid redirecting a flagged-in user who cold-loads
  a deep link before flags resolve. The visibility variant (`useSkillsEnabled`)
  still fails closed.

| Flag | Gates (representative) | Blocked-state default | Safe? |
|------|------------------------|-----------------------|-------|
| `evaluate-ci` | `App.tsx`, `mcp-sidebar.tsx` | Evals-CI nav hidden | ✅ |
| `mcpjam-learning` | `mcp-sidebar.tsx` | Learning nav hidden | ✅ |
| `registry-enabled` | `mcp-sidebar.tsx` | Registry nav hidden | ✅ |
| `mcpjam-conformance` / `mcpjam-compatibility` | `mcp-sidebar.tsx` | Nav hidden | ✅ |
| `sandboxes-enabled` / `learn-more-enabled` | `mcp-sidebar.tsx` | Nav hidden | ✅ |
| `skills-enabled` | `useSkillsEnabled(State)` | Skills hidden; route guard waits on tri-state | ✅ |
| `computers-enabled` | `useComputersEnabled(State)` | Computers hidden; route guard waits on tri-state | ✅ |
| `claude-code-host-enabled` / `codex-host-enabled` | host hooks | Host template hidden | ✅ |
| `tool-quality-enabled` | `useToolQualityEnabled` | Quality badges hidden | ✅ |
| `synthetic-monitors` | evals suite views | Monitors hidden | ✅ |
| `mcp-inspector-multi-host/model-enabled` | playground | Feature off | ✅ |

For every beta/nav/opt-in feature, fail-closed is **correct**: a not-yet-GA
surface briefly not showing is strictly better than flickering it on for a
user who shouldn't have it.

## Removed: flags that reached 100%

`billing-entitlements-ui` and `xaa` finished their rollouts at 100% for all
users and have been removed from the code entirely, along with
`home-page-enabled` and `hosts-enabled` (whose sidebar entries were already
auth-driven rather than PostHog-driven — they now use the explicit
`authVisibility` field on `NavItem`).

`stateless-mcp-enabled` is also at 100% in PostHog but had no gate left in the
code — the per-server protocol toggle it once guarded is already un-flagged.
Only a stale test comment referenced it, now corrected.

Removing them also removes their first-paint flicker: the surfaces they gated
now render immediately instead of waiting on `/flags`. That resolved the one
case this audit had flagged as ⚠️ — `billing-entitlements-ui`, which gated
billing UI for *paying* orgs and could briefly hide a surface a customer had
already paid for. It also closes the opposite direction: a free-plan org no
longer sees unlocked premium UI during the window before the gate resolved.

Note for self-hosted builds: these features are now on unconditionally. Before
removal, an install with no PostHog configured left every flag `undefined` and
therefore hid them.

These flag keys are safe to archive in PostHog; nothing reads them.

## Verdict

Post-relay, the fail-closed defaults are safe for the flags that remain. No
gate needs to change its default.
