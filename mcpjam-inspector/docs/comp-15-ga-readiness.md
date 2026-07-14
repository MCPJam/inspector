# COMP-15 — Claude Code host GA readiness record

Working record for the acceptance criteria of COMP-15 ("M0: Claude Code host
to GA quality"). Dated statements were verified on 2026-07-14.

## 1. Dependency status

- **COMP-3 (guest gate):** the backend gate shipped dark (backend #654 +
  inspector #2991, both in `main`). The guest **sign-in affordance + flag-off
  regression tests** are still unmerged on
  `feat/comp-3-guest-signin-affordance` (5 commits ahead of `main`, incl.
  `126775f98` and `a83470b5a`). COMP-15 item 1 says "land first or together" —
  that branch needs its own review/merge; it is not folded into this one.
- **COMP-23 (member spend metering) — the GA blocker:** answered and FIXED on
  branches pending review:
  - backend `feat/comp-23-broker-convergence` — raw-key
    `/web/harness/model-credential` retired (unconditional 410), dead
    client-lease endpoints deleted, model proxy broker-only;
  - inspector `feat/comp-23-broker-delivery` — broker delivery default-ON
    kill switch, raw-key client deleted, pre-stream availability gate.

## 2. Branch/main delta sweep (item 2)

- `feat/claude-code-harness-host` **does not exist** — not locally, not on
  `origin`, not on `fork` (checked 2026-07-14). Whatever memory said sat
  uncommitted there has either been merged via the PR train (#2996, #2998,
  #2991 are all in `main`) or is gone; there is no unmerged harness-host work
  to port. No "harness-mcp-proxy port notes" file exists in the repo — the
  proxy landed as `server/utils/harness/harness-proxy-strategy.ts` +
  `mcp-config.ts` + the `harnessMcpProxy` option.
- Conclusion: `main` + the two COMP-23 branches + the COMP-3 affordance branch
  is the complete GA surface; nothing else is dangling.

## 3. Member-spend-attribution answer (item 5, acceptance criterion)

**Verified answer:** before COMP-23, member in-sandbox model calls used the
raw system AI Gateway key via `/web/harness/model-credential` with **zero
metering** (no `llmUsageRecord`, no credit consumption, no spend cap) — i.e.
attribution did NOT work; the spend was MCPJam's own money. Prod was LATENT
(2026-07-09 flag audit: `MCPJAM_HARNESS_ALLOW_ENV_CREDENTIAL`,
`MCPJAM_HARNESS_MODEL_PROXY_ENABLED`, `MCPJAM_HARNESS_MODEL_BROKER_ENABLED`
all unset → the member harness failed closed and nothing leaked; re-confirmed
read-only 2026-07-14). With the COMP-23 branches, member harness spend is
metered per generation through the model proxy into `llmUsageRecord` with
`spendingPolicy: 'consume_mcpjam_limit'` — the same accounting as chat.
**Claude Code host must not GA before the COMP-23 branches deploy** (and the
operator executes `mcpjam-backend/docs/harness-broker-rollout.md`).

Computer-time metering for harness runs needs no special handling: the
harness keeps the Computer awake, and awake time is metered by the standard
`meteredUpTo` sweep regardless of what runs inside (COMP-1 owns flipping that
to enforce).

## 4. QA checklist (item 3) — execution record

Environment: local dev stack (`npm run dev`) against dev Convex
`wry-sandpiper-867` with the COMP-23 backend deployed and broker flags set
(`MCPJAM_HARNESS_MODEL_PROXY_ENABLED=true`,
`MCPJAM_HARNESS_MODEL_BROKER_ENABLED=true`, `HARNESS_MODEL_LEASE_SECRET` set),
`COMPUTERS_PROVIDER=e2b`.

| # | Scenario | Expected | Result |
|---|---|---|---|
| 1 | Select Claude Code host on a project | Host seeds harness + computer template | _see COMP-TESTPLAN.md QA notes_ |
| 2 | Run a task against a real MCP server | Computer wakes, turn streams, MCP tools callable | _see COMP-TESTPLAN.md QA notes_ |
| 3 | WS3 approval flow | Turn pauses on side-effecting tool, resumes with decision | _see COMP-TESTPLAN.md QA notes_ |
| 4 | File changes visible | Files land on the Computer disk | _see COMP-TESTPLAN.md QA notes_ |
| 5 | Transcript persisted | Turn + trace in history after reload | _see COMP-TESTPLAN.md QA notes_ |
| 6 | Computer asleep at start | Turn wakes it (no stuck spinner) | _see COMP-TESTPLAN.md QA notes_ |
| 7 | Computer at daily start cap | Limit dialog with CTA (`isComputerStartLimitError`) | unit-verified (`ComputerView` handler); live repro needs cap exhaustion |
| 8 | Model gate rejection (non-eligible model) | Pre-stream friendly error, no silent emulated fallback | covered by `harness-availability` tests + live check |
| 9 | Broker delivery killed | Pre-stream 503 naming `MCPJAM_HARNESS_BROKER_DELIVERY` | covered by `run-harness-turn-broker-required` + `harness-availability` tests |
| 10 | Sandbox dies mid-run | Honest error + fresh session next turn (`HARNESS_RESET_MESSAGES`) | code-traced (`use-chat-session.ts:147-152`); live repro destructive |

## 5. Error-surface inventory (item 4)

Pre-stream (friendly, via `checkHarnessRuntimeAvailable` → chat-v2 503):
data-plane missing, broker killed, approval-capability conflicts, MCP servers
on a non-delivering harness, model not eligible / not runnable.

In-turn fail-closed backstops (emitError → chat error part, loading indicator
clears; not stuck spinners): broker start failure (backend flags off → 403,
spend limit → 429 with top-up hint), computer wake failure, E2B connect
failure, sandbox death (session reset message on the next turn).

Computer-view states: `error` status chip + `lastError` text, start-limit
dialog, billing pause notice (COMP-7), usage meter (server-driven allowance).

## 6. Remaining before the GA flag flip

1. Merge + deploy the two COMP-23 branches; execute
   `mcpjam-backend/docs/harness-broker-rollout.md` on prod (operator).
2. Merge `feat/comp-3-guest-signin-affordance` (COMP-3 affordance).
3. Decide enforcement-proxy (PR2) scope in/out of GA and say so in release
   notes (out, per this record — UI grays out unenforceable knobs today).
4. Flip `claude-code-host-enabled` PostHog flag per COMP-19's sequence (member
   stage requires COMP-23 deployed — now a hard requirement).
