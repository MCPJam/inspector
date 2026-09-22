# Slack app: rollout and cleanup runbook

The public-install program landed in four phases. Phases 0–3 are in the code.
Phase 4 is a **deliberate cleanup step that must not be run early** — it
deletes the credential path our own workspace is still using, so doing it
before the preconditions hold takes the live bot down.

## Where things stand

| Phase | What shipped | State |
| --- | --- | --- |
| 0 | Tenant threaded through every cache/dedupe key | done |
| 1 | Multi-workspace OAuth install, Vault-backed installation store | done |
| 2 | Durable event claims + write-path idempotency keys | done |
| 3 | Account linking (dual identity proof), per-user auth, thread bindings | done |
| 4 | Delete the legacy shared-key fallback | **blocked — see below** |
| 5 | Gated toolset (proposal-only ops behind a human click) | see plan |

## Before public distribution opens

Distribution is currently activated **only** so the install flow can be
exercised against a throwaway second workspace. The single release gate is the
Phase 3 E2E passing in real workspaces:

- [ ] Unlinked DM → connect → Slack OIDC → AuthKit → default project picked →
      a suite lands in that org/project.
- [ ] **Phishing attempt**: open another user's link URL from a browser signed
      into a *different* Slack identity → OIDC mismatch → session `failed`,
      and the URL stays dead.
- [ ] WorkOS callback hit **without** a completed Slack leg → rejected by the
      state machine.
- [ ] Replay a consumed link URL → rejected.
- [ ] A user in the second workspace links a *different* org → full isolation.
- [ ] Thread started by user A continues with user B **only** if B can reach
      A's bound project, and the suite stays in the bound project.
- [ ] Bot restart mid-thread → the thread is still engaged (durable binding).
- [ ] Unlink → the connect prompt returns.

Security checklist (same gate):

- [ ] OIDC identity mismatch hard-stops and burns the session.
- [ ] Link sessions are single-use.
- [ ] Bad-signature events rejected (Bolt).
- [ ] `slk_` on a non-allowlisted path → 401.
- [ ] Backend blip → 503, never a link prompt.
- [ ] Delegated mint fails for a user removed from the org.
- [ ] Per-link rate bucket enforced.
- [ ] Thread binding prevents cross-org drift.
- [ ] Replayed Slack event envelopes and double-clicked buttons cannot
      double-execute.
- [ ] No secret in bot logs.

## Phase 4 cleanup — preconditions

Do **not** start until all three hold:

1. **Our workspace is on a real OAuth install.** Verify a `slackInstallations`
   row exists for it whose grant came from `/slack/install`, not from
   `migrations/seedLegacySlackInstallation`.
2. **Internal users are linked.** Every person who uses the bot has completed
   the connect flow. Until then, `resolveTurnTarget` still falls back to the
   shared key for the unlinked ones, and removing it locks them out
   mid-conversation.
3. **The two transcript-exposed `sk_` keys are rotated.** They were pasted in
   plaintext during development. Rotating them is independent of this cleanup
   and should not wait for it.

## Phase 4 cleanup — steps

Once the preconditions hold, in this order:

1. **slack-app**: delete the `legacy` branch from `getConfig` in
   `agent/mcpjam-client.js`, the legacy fallback in `resolveTurnTarget`
   (`agent/turn-target.js`), and the `isLegacyWorkspace` plumbing in
   `listeners/middleware/tenant-guard.js` / `agent/slack-context.js`. Remove
   `MCPJAM_API_KEY` and `MCPJAM_PROJECT_ID` from `.env.sample`, the README,
   and the Railway service.
2. **Watch for a day.** An unlinked internal user surfaces as a connect
   prompt, not an outage — but it is worth seeing zero of them before
   proceeding.
3. **Backend**: drop `isLegacyWorkspace` from `slackInstallations` and delete
   `migrations/seedLegacySlackInstallation.ts`. This is last because the
   column is what the slack-app change stops reading, and the two deploys are
   not simultaneous.

Ordering matters in both directions: the backend column must outlive the code
that reads it, and the code must stop reading it before the column goes.

## Rotating the bot service token

`slk_` is verified against `MCPJAM_SLACK_SERVICE_TOKEN_HASH` on the inspector
(SHA-256 hex, constant-time compare). To rotate without downtime:

1. Mint a new token: `TOKEN="slk_$(openssl rand -hex 32)"`.
2. Deploy the inspector with the NEW hash **and** keep accepting the old one
   if you need a true zero-gap window (add a second env var and check both),
   or accept a brief 401 window if you do not.
3. Deploy the bot with `MCPJAM_SLACK_SERVICE_TOKEN` set to the new value.
4. Drop the old hash.

Never do step 4 before step 3 — the bot would 401 on every request.
