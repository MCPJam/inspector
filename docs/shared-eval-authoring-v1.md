# Shared eval authoring and durable agent turns, version 1

Companion branches: `MCPJam/mcpjam-backend:feat/shared-eval-authoring` and `MCPJam/inspector:feat/shared-eval-authoring`. Deploy the backend contract before enabling inspector clients. Do not merge or enable production flags until the authenticated development acceptance flow has been checked.

## Authoring

The versioned inspector authoring endpoint captures the authorized suite/environment tool snapshot, then starts a customer-paid backend job. Markdown, generation instructions, and agent requests enter the same worker. Markdown planning keeps complete workflows together, at most 50 cases and five cases per drafting invocation. The worker uses Haiku 4.5 and the Gateway-preferred resolver. No authoring step executes an authored tool call or UI interaction.

Jobs, source/context payloads, provider attempts, and drafts are separate records. Draft steps are authoritative; UI compatibility fields use the existing step converters. Drafts preserve source excerpts, issues, proposed additions, checks, model overrides, and run counts. Imported cases default to five runs and suite model inheritance.

Editing increments the saved revision and clears acceptance. Replaying the same edit after a lost response returns the saved revision. Acceptance requires resolving blocking issues and acknowledging each proposed addition. The case-write transaction checks the author, accepted revision, and exact frozen payload. Unknown save outcomes retry the original case ID and payload through the existing batch writer. Confirmed failures unlock editing. Committed cases are excluded from draft polling.

Payloads are bounded: request/context and attempt payloads at 700 KB, individual drafts and frozen cases at 64 KB. Oversized inputs fail explicitly and published drafts remain available. Provider results are checkpointed before the next unit. Completed attempts are replayed without inference. A crashed invocation with unknown outcome is held for reconciliation; available recorded usage is attached to the attempt. This is not an exactly-once inference guarantee.

## Agent turns

Convex admits at most four running turns per organization and serializes each conversation. Inspector workers run the existing engine for one model round and checkpoint before the model, before tools, after each tool result, and after the round. The existing 16-step bound applies across persisted history. Leases fence stale checkpoints; active work is limited to 30 minutes. The worker reconstructs short-lived delegated authority and rechecks current user membership, key binding, linked surface identity, and operation policy.

Tool intent is recorded before execution. Recorded results are reused. Replayable platform operations retain their original tool-call identities and write keys. Uncertain non-idempotent operations and uncertain model invocations are held rather than blindly repeated. Explicit cancellation prevents future checkpoints and keeps created resources. Approvals remain separate from review, and approval waits finish the worker pass.

Slack stores a reply handle before dispatch. Both normal completion and restart recovery update that same message and acknowledge delivery. A lost delivery acknowledgement repeats an update, not a new message. Delivery rechecks the linked actor and retrieves the current installation token; tokens are not stored in turn payloads.

## Rollout and rollback

1. Deploy backend schemas, job functions, billing receipts, review guards, and recovery crons.
2. Set backend `EVAL_AUTHORING_V1_ENABLED=true`; configure matching `INSPECTOR_SERVICE_TOKEN` values.
3. Enable client flag `eval-authoring-import-v1`, then `eval-authoring-generation-v1` for the development cohort.
4. Set inspector `EVAL_AUTHORING_GENERATION_V1_ENABLED=true` for public API and agent generation. The generation compatibility endpoint waits up to 15 seconds, then returns a resumable job ID. The SDK follows the ID and commits eligible generated drafts.
5. Configure backend `INSPECTOR_INTERNAL_ORIGIN`, then enable `DURABLE_AGENT_TURNS_ENABLED=true` on backend, inspector, and Slack together. Keep the existing conversation model.
6. Verify Markdown import → review → save → run; equivalent generated full steps; interrupted worker recovery; and Slack reply recovery before expanding the cohort.

Legacy prompt-only import save payloads remain supported by their existing adapter. Legacy extraction/generation paths remain available while their rollout flags are off. Full-step draft responses stay on the versioned authoring API and are never flattened into legacy import responses.

Rollback disables new entry through flags. Keep version-1 backend and worker handlers deployed until existing jobs drain; claim/recovery and Slack delivery continue for existing jobs even when entry flags are disabled. Do not remove tables during rollback. The daily retention sweep applies the organization evidence-retention policy, caps cancelled payload retention at seven days, and leaves identity tombstones so an expired request key cannot silently cause new spend.

## Validation record and remaining release gates

Automated coverage includes full-step contracts, source/review state, revision invalidation, frozen writes, repeated saves, cancellation fencing, provider replay/unknown outcomes, per-organization admission, conversation ordering, tool intent replay, and Gateway/OpenRouter usage callbacks without hidden fallback. Existing agent engine, import UI, SDK client, Slack, and surface-core suites are also run.

The personal development deployment is `dev:exuberant-albatross-496` (the user's development environment, not `.env.local`). Convex code generation against it succeeded. The worktree UI booted, but authenticated end-to-end verification could not be completed because worktree sign-in is unavailable. No live Slack completion message was sent. These live acceptance checks remain release gates; automated tests do not replace them.

The broad backend suite exposed two OAuth secret-storage test failures; emulator suites and the 1,000-trial findings suite passed when rerun with local networking allowed. Standalone inspector server typecheck reports existing repository errors, including test declarations and nullable legacy paths. The new authoring/worker modules have no reported server type errors. Backend/client/SDK typechecks and surface package checks are run separately.

Both new contract copies and the full step-schema fixture are compared by content. The broader cross-repository mirror audit reports four differences in untouched main-branch pairs: public API internal-error mapping, benchmark claim payload, benchmark cleanup status, and decision-label remedies. Resolve those independent rollout differences before treating the complete cross-repository audit as clean.

## Review follow-up (2026-09-16)

Verified the supplied review findings against the current branch. Fixed bounded
status-read retries (reset after success; permanent HTTP errors stop immediately),
400 input errors and stable 502 upstream errors, owned durable-dispatch leases,
hosted-only job routes, malformed job IDs, successful-only SDK commits, and Slack
pending-turn/acknowledgement recovery. Tool argument records now remain open in
both schema fixtures, generated from native Zod JSON Schema conversion. CI compares
the authoring implementation and fixture against a pinned backend commit; updating
the shared contract requires updating that pin. Fork and Dependabot PRs cannot run
the private-backend comparison because they do not receive its checkout credential.

Two requested changes were skipped after checking their premises:

- Local `authFetch` uses the inspector's random, process-level session token
  (`server/services/session-token.ts`), which has no user identity to compare.
  The separate Convex token identifies the actor and Convex checks access. Adding
  an actor comparison against the local token would reject legitimate local use.
- Addition checkboxes mean acceptance, not a separate rejection decision. The
  backend's revision-bound `acceptDraft` intentionally requires all proposed
  additions to be accepted. Merely counting an unchecked addition as reviewed
  would retain rejected content in the saved case or fail server validation.
  A rejection workflow needs a defined edit/removal contract before changing this.

Validation: focused inspector routes, client polling, SDK schema, Slack delivery,
and backend review/checkpoint suites pass. Backend, client and SDK typechecks,
Slack check/lint, use-node and mirror checks are run separately. Personal env.dev
received the schema correction; authenticated browser QA remains outstanding.

Standalone server typecheck still reports the existing declaration, legacy-route,
and test typing errors; no new errors were reported in the authoring fixes. Backend
lint passes with its existing warnings. No production deployment or merge was done.

## Review follow-up after rebase

Both feature branches were rebased onto current main. All findings in this review
were valid: read-only generation now reports a validation error; pending agent
jobs use the top-level wire shape; absent jobs and failed/cancelled authoring jobs
are handled without committing; case receipts omit unreadable documents and keep
skipped entries in the declared shape. Slack retains the completed job ID for
acknowledgement and edits the existing placeholder on failure.

Approval responses with unresolved calls are checkpointed before reconciliation.
Recovery sends those responses through the approval handler instead of executing
raw calls (including denied calls). The model checkpoint remains in place and
MRTR resume handling is unchanged. No tools-phase checkpoint is introduced for
histories without pending approval responses: a crash there must still resume the
model, rather than being mistaken for a completed tool phase.

The schema's predicate exclusion branch stays open to predicate fields. Mirror
comparison now uses TypeScript lexical tokens, preserving literal values while
allowing different quote delimiters. CI installs the locked dependencies for the
checker and tests quote preservation before comparing the pinned backend.
