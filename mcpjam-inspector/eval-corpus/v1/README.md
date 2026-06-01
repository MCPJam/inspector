# MCPJam eval corpus — v1

A version-controlled set of **workflow-task eval cases** for MCP servers. Each
case pairs a natural-language `query` with a deterministic **predicate gate**,
so the same task can be run on multiple agent harnesses (Claude / OpenAI /
Gemini) and produce a reproducible per-harness pass/fail — the property a CI
release gate requires and a stochastic LLM judge cannot provide.

The corpus is checked into git (not Convex) on purpose:

- **PR-reviewable** — every addition or promotion is a reviewable diff.
- **Forkable / citeable** — external devs can read it on GitHub, propose
  additions, and use it to understand what "good" looks like.
- **No auth to read** — the canonical corpus needs no Convex credentials.

Cases become Convex `testSuiteRun` + `testIteration` rows the moment they run,
through the same runner as user-defined cases. The JSON files here are the
source of truth; Convex is the execution log.

## Case shape

A case is a [`CorpusCase`](../../shared/corpus/types.ts), validated by
[`validateCorpusCase`](../../shared/corpus/validate.ts):

```jsonc
{
  "id": "booking.cancel.refund",            // stable id
  "title": "Cancel booking issues refund",
  "server": "booking-mcp",                   // target MCP server
  "query": "Cancel my flight and confirm the refund.",
  "expectedToolCalls": [
    { "toolName": "cancel_booking", "arguments": { "id": "abc" } }
  ],
  "successPredicates": [                      // the deterministic gate
    { "type": "toolCalledAtLeastOnce", "toolName": "cancel_booking" },
    { "type": "responseContains", "needle": "refund issued" }
  ],
  "reviewStatus": "human_reviewed",          // "llm_draft" | "human_reviewed"
  "category": "single-mutation",
  "provenance": { /* see below */ },
  "notes": "Refund text is required; cancel must fire at least once."
}
```

At run time the harness supplies `model` / `provider` / `runs`; the case itself
is harness-agnostic.

### Predicates

The deterministic gate. A case passes iff **every** predicate passes. The
library (see [`shared/predicates/types.ts`](../../shared/predicates/types.ts)):

| `type` | passes when |
| --- | --- |
| `toolCalledWith` | a call to `toolName` matches `args` (≥ `minCount`, default 1) |
| `toolCalledAtLeastOnce` | `toolName` was called at least once |
| `toolNeverCalled` | `toolName` was never called |
| `responseContains` | final assistant message contains `needle` (case-insensitive unless `caseSensitive`) |
| `responseMatches` | final assistant message matches the regex `pattern` |
| `noToolErrors` | no tool produced an `isError: true` result or a JSON-RPC/transport error |
| `finalAssistantMessageNonEmpty` | the final assistant message is non-empty |
| `tokenBudgetUnder` | total token usage is strictly under `tokens` |

`toolCalledWith.args` reuses the eval matcher's `argumentMatching` semantics
(`partial` default, `exact`, `ignore`).

Design predicates to be **robust to reasonable agent-planning variation** —
avoid asserting strict tool ordering unless ordering is semantically required.
The agent is stochastic at the planning layer; the predicate set should not be.

## Review status — only `human_reviewed` may gate

- `llm_draft` — drafted by an LLM from a trace or ToolBench seed. A review-queue
  entry. **Never** usable with `--gate`.
- `human_reviewed` — a human verified, sanitized, made-runnable, and promoted
  the case. The **only** status `--gate` will run. Requires reviewer metadata
  (`provenance.reviewedBy`) and a non-empty predicate set.

The drafting model should not be the production `serverQuality` judge model —
avoiding self-reinforcement keeps the review queue honest.

## Provenance

Required so a human can audit a draft before promoting it.

**Trace-derived** (primary source — real `chatSessionTurnTraces` + `hostConfigs`):

```jsonc
"provenance": {
  "source": "trace",
  "draftingModel": "claude-haiku-4-5",
  "traceId": "…", "chatSessionId": "…", "promptIndex": 0,
  "hostConfigId": "…",
  "toolSnapshotHashAtTurn": "…",            // OR "manualToolInventoryNote": "…"
  // privacyReview must be reviewed:true before promotion, and a completed
  // review must name its reviewer + timestamp.
  "privacyReview": { "reviewed": false },    // draft; reviewer/at added on review
  "reviewedBy": "…", "reviewedAt": "…"       // case reviewer; set on promotion
}
```

> **Privacy review is mandatory for trace cases.** Do **not** commit raw private
> prompts/responses, secrets, workspace-specific ids, or customer data. The
> committed case must be a sanitized, runnable workflow derived from the trace,
> with enough provenance to audit internally. A trace case needs either a
> `toolSnapshotHashAtTurn` or a `manualToolInventoryNote` explaining how the
> tool inventory at the original turn was reconstructed.

**ToolBench-derived** (fallback/public seed source):

```jsonc
"provenance": {
  "source": "toolbench",
  "draftingModel": "gpt-5-mini",
  "toolbenchSnapshotKey": "toolbench-2026-05-31-fast-v1",
  "toolbenchId": "tb_123",
  "originalIssueIds": ["issue_1"]
}
```

## Contributing

1. **Draft** with a corpus script (writes `reviewStatus: "llm_draft"`):
   - `scripts/corpus/draft-from-turn-traces.ts` (real traces, primary)
   - `scripts/corpus/draft-from-toolbench.ts` (public seed, fallback)
2. **Review**: verify the source, sanitize private/workspace data, make the case
   runnable against a local MCP server, capture a passing run, and tighten the
   predicates so they're robust to planning variation.
3. **Promote** to `human_reviewed` (set `reviewedBy` / `reviewedAt`; for trace
   cases set `privacyReview.reviewed: true` with its own `reviewedBy` /
   `reviewedAt`).
4. **Validate** before committing — every case must pass `validateCorpusCase`;
   gate cases must pass `isGateEligible`.

Stratify across categories so the corpus exercises the full surface:
`read-only`, `single-mutation`, `multi-step`, `error-recovery`,
`large-output`.

Drafts are an **authoring accelerator, not truth.** Expect to fix privacy
redactions, workspace-specific ids, overly strict predicates, and tool
names/arguments before promotion.
