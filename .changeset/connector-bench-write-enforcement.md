---
"@mcpjam/inspector": patch
---

Connector Bench: write-manifest enforcement, the artifact ledger, and cleanup

A benchmark write case creates things on a server somebody else operates. The tool-policy gate could say which tools may be called; it could not say what they may be called **with**, and "may call `create_page`" is not a bound on anything — the same permission covers creating a page named for this run and overwriting the operator's homepage.

**The gate now wraps allowed tools too**, with a per-call argument inspector driven by the pinned `caseMetadata` side-effect manifest. The manifest is resolved by `suiteHash + caseId` and verified against the definition's `caseMetadataHash` **before** anything launches: a manifest that cannot be tied to the generation the job was admitted under is not one we may enforce, because the write rules the payer consented to would not be the rules that ran. Three rules follow from it:

- **Prefix.** The value at `artifactNamePath` must start with `mcpjam-benchmark-<runId>-<iteration>`. Per-iteration, so a list-style case cannot observe its own sibling iterations' artifacts and grade a leak that is ours.
- **Created-id harvesting.** Ids at `createdIdResultPaths` land in the run's artifact ledger as they are created.
- **Mutation targets.** Every id at `mutationTargetPaths` must be one this run created. An update or a delete aimed at anything else is somebody else's data.

Violations are blocked **before** the MCP call, through the existing `recordBlock` + `TOOL_POLICY_BLOCK_MARKER` path, so both gate invariants hold unchanged: a block emits no tool span, and `isToolPolicyBlockResult` still recognizes it. A check after the fact would be a report about damage rather than a bound on it. The manifest's reason vocabulary is deliberately separate from the SDK's `ToolPolicyDecisionReason`: those reasons travel to the out-of-process harness proxy, which decides by tool name and never sees arguments.

**A run tidies up after itself, whatever else happened.** Cleanup replays the ledger in a `finally`, after every cell has disconnected, over its own connection, with **no model call anywhere on the path** — a run that exhausted its budget still has to remove what it left behind, so the one thing cleanup must not depend on is the thing that ran out. It is idempotent and retried; an artifact that survives every attempt is counted as residue and reported for the scorecard rather than swallowed. Cleanup dials the target rather than the backend, which is why it also runs after a lost lease: the ids are in this worker's ledger and no other worker can see them.

The terminal sequence is now fixed and explicit: children → cleanup → execution-complete (carrying the cleanup status) → finalize → flow analyzer → job complete **last**. The analyzer produces an inferred artifact and can never delay or change a scorecard, and the job's lease deliberately outlives finalization so a worker lost mid-assembly is swept rather than leaving a run parked in `awaiting_evidence` with a complete roster.
