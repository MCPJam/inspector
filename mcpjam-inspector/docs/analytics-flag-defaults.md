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
| `billing-entitlements-ui` | `App.tsx:1321`, `OrganizationsTab.tsx:561`, `ShareProjectDialog.tsx:235` | Billing/entitlements UI hidden | ⚠️ see below |
| `evaluate-ci` | `App.tsx`, `mcp-sidebar.tsx` | Evals-CI nav hidden | ✅ |
| `mcpjam-learning` | `mcp-sidebar.tsx` | Learning nav hidden | ✅ |
| `registry-enabled` | `mcp-sidebar.tsx` | Registry nav hidden | ✅ |
| `mcpjam-conformance` / `mcpjam-compatibility` | `mcp-sidebar.tsx` | Nav hidden | ✅ |
| `xaa` / `xaa-registration` | `mcp-sidebar.tsx`, XAA components | XAA surfaces hidden | ✅ |
| `sandboxes-enabled` / `learn-more-enabled` | `mcp-sidebar.tsx` | Nav hidden | ✅ |
| `skills-enabled` | `useSkillsEnabled(State)` | Skills hidden; route guard waits on tri-state | ✅ |
| `computers-enabled` | `useComputersEnabled(State)` | Computers hidden; route guard waits on tri-state | ✅ |
| `claude-code-host-enabled` / `codex-host-enabled` | host hooks | Host template hidden | ✅ |
| `tool-quality-enabled` | `useToolQualityEnabled` | Quality badges hidden | ✅ |
| `synthetic-monitors` | evals suite views | Monitors hidden | ✅ |
| `stateless-mcp-enabled` | per-server protocol toggle | Opt-in stays off | ✅ |
| `mcp-inspector-multi-host/model-enabled` | playground | Feature off | ✅ |

For every beta/nav/opt-in feature, fail-closed is **correct**: a not-yet-GA
surface briefly not showing is strictly better than flickering it on for a
user who shouldn't have it.

## The one to watch: `billing-entitlements-ui`

This gates billing/entitlements UI for **paying** orgs. Fail-closed means: if
the flag hasn't resolved, a customer who has paid briefly doesn't see the
billing surface they're entitled to. With the relay + bootstrap this window is
now small (same-origin, no ad-block), so the residual risk is only the
first-paint moment on a cold load.

**Recommendation:** leave it fail-closed (showing billing UI to a
not-entitled org would be worse), but confirm the gate renders a neutral
loading state — not an "upgrade" CTA — while the flag is `undefined`, so a
paying customer never momentarily sees an upsell for something they already
have. The tri-state pattern (`billingUiFlag === undefined` → skeleton, not
CTA) is the fix if any gate currently shows the un-entitled variant during
load.

## Verdict

Post-relay, the fail-closed defaults are safe. No gate needs to change its
default. The only follow-up is the `billing-entitlements-ui` loading-state
check above — a UX nicety, not a data-loss issue.
