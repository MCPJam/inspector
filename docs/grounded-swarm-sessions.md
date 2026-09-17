# Grounded swarm sessions

New journeys created by the UI default to `config.setupWrites: true`. The launch
confirmation switch can disable it. Existing journeys and API calls that omit it
keep setup off; every new run pins its journey's configuration in the snapshot.
API updates send `setupWrites` together with `sessionsPerTarget` and `maxTurns`.

Before claiming sessions, each target optionally attempts prerequisite creation,
then probes annotated read-only tools with no required arguments. The setup turn
uses the shared billed host-model turn runner, with at most eight tool executions,
six steps and 90 seconds. Discovery allows 12 tools, eight seconds per call,
20 seconds total, 16 KiB per result and 48 KiB overall.

Setup admits read-only tools and creation-shaped names annotated non-destructive.
This is a heuristic, not a guarantee of effects. Prefixes are requested, not
enforced, and created entities are not cleaned up. Use a test account.

Names and IDs come from result objects, preserving their association and case.
The condensation model selects source record references; code renders the facts.
Unsupported shapes are omitted. Ambiguous creation envelopes fail to establish
creation evidence. Omitted creations still appear in the setup record when their
results establish their identity. Residue beyond 25 entities is marked incomplete
and makes setup unavailable.

A turn can complete without establishing readiness. Unavailable prerequisites fail
that target's pending attempts; siblings continue. Only a transport failure before
any write dispatch can retry. Missing eligible creation tools mean setup was not
assessed and sessions can continue. Discovery and reporting failures degrade to an
ungrounded persona, which must ask for existing names instead of inventing them.

Setup records live in `journeyRuns.grounding`, outside chat sessions, grading and
Findings. The run disclosure shows facts, created entities, tool calls, readiness
and residue. Setup stream events do not create session cells. Recorded session
context exposes the target's grounding for trace review.

Deploy the companion backend changes before serving this inspector version. The
inspector tolerates a missing grounding endpoint. Existing stored records need no
migration. Disabling setup affects future launches, not snapshots already running.

Implementation was validated with the swarm runner, UI, API, SDK and backend tests;
backend and client typechecks; design checks; and the grounding mirror pin. No live
billed dev swarm was launched. Before rollout, run the plan's dev smoke scenario
against a test org and verify returned entity IDs, usage attribution and no setup
chat-session row. The existing server typecheck errors and four unrelated
cross-repository mirror mismatches remain outside this change.
