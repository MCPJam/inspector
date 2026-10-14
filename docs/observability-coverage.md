# Observability coverage contract

Definition version 1, completed for [PP-24](https://app.kestral.ai/workspace/yhNILB2/task/1OCulq23) on October 14, 2026. Implementation follows [PP-56](https://app.kestral.ai/workspace/yhNILB2/task/1O2sgFk2). This defines the target; it does not claim that production has reached it.

Every supported production surface must have an explicit observation requirement or a reviewed exemption. A requirement is covered only when its behavior, delivery and required detection are verified for the stated release and deployment. Sentry, Axiom and PostHog have different denominators; never average them into one score.

## The simple explanation

List every room. Say what each room needs. Check that it works. Check again when the house changes. Forgetting a room, installing a broken alarm, or crossing an unfinished job off the list cannot make coverage 100%.

## Scope and discovery

Inventory supported production code in both repositories, recording repository revision, discovery method and deployment/release. Development, staging and controlled probes provide verification; production claims require matching deployed code and configuration. The separate Next.js website is a named follow-up outside PP-56, not silently included in a whole-company claim.

Discover the following from registrations and entrypoints, including dynamically registered routes:

| Surface | Inventory unit |
| --- | --- |
| Inspector hosted and local/desktop servers | Method plus normalized route, entrypoint, auth/admission boundary, stream completion |
| Convex | Queries, mutations, actions, HTTP handlers, registered crons, scheduled/detached work |
| Browser and desktop | API operations, React error boundaries, uncaught errors/rejections, main/renderer processes, crash and startup/shutdown paths |
| CLI, SDK, MCP and integrations | Commands, public operations/handlers, service entrypoints and detached work |
| Durable work | Admission, stages, terminal writers, recovery/timeout paths and existing deadlines for evals, swarms, readiness, conformance, benchmarks, billing and analysis |
| Product journeys | Every supported user/agent goal and meaningful decision, attempt and outcome, with its supported entry surfaces |

Static assets and pure shared helpers are classified explicitly. Shared libraries inherit observations through verified callers; a library that launches detached work needs a separate boundary. Multiple handlers sharing an adapter retain separate inventory rows. One detector may cover many rows only with evidence that its selector includes each row. Absence of recent traffic never removes a supported boundary.

Operational discovery is generated from code. Product journeys are catalogued from the feature/surface map and reconciled with routes, commands, public operations, UI actions and event registries. Existing event names alone cannot discover a feature that emits nothing. New features must declare their journey applicability as part of review.

## Requirements and counting

Use a stable boundary or journey ID with service, operation/stage, deployment mode and supported runtime/build variant. An observation requirement adds the sink, signal class and behavior to verify. Separate hosted/self-hosted, browser/desktop, client/server and admission/settlement when their reporting paths differ. Preserve platform/build distinctions needed for source maps. Do not create one row per customer installation or raw URL.

Record: ID, code registration/caller, owner role, sink applicability, expected outcomes, adapter/producer, expected context, deployed configuration, detector/query when required, behavioral test, delivery evidence, evidence timestamp and release, status, exemption and implementation task.

Owner roles follow the affected service/domain maintainer. PP-24 owns the definition; PP-80 owns inventory assembly and delivery evidence; implementation owners follow the linked tasks. An unassigned requirement stays visible as an ownership gap.

Requirement status is one of:

- **Verified:** all applicable gates passed with evidence matching the deployed release/configuration.
- **Instrumented but unverified:** a producer/adapter exists; one or more proof gates remain.
- **Gap:** a required producer, property, behavior, query or detector is missing or fails.
- **Unknown:** discovery, applicability or evidence has not been resolved.
- **Exempt:** the exact requirement has a reviewed reason, reviewer, owner and review condition. Exemptions are counted separately, never as verified signals. Directory-wide or tool-wide exemptions are prohibited.

Applicability is determined before verification. An unknown applicability remains pending and blocks a 100% claim; it cannot be treated as exempt. Consent opt-outs, deliberate sampling, client blockers and unsupported builds are declared measurement limitations, not broad excuses to exempt supported code.

Publish these separate measures:

1. **Inventory accounting:** rows with resolved applicability and status / all discovered rows. Unknown rows remain in the denominator. A claim also requires completed discovery for every scoped surface; 100% of a partial scan is not full inventory.
2. **Instrumentation coverage per sink:** implemented applicable requirements / all applicable requirements.
3. **Verified coverage per sink:** verified applicable requirements / all applicable requirements. Instrumented, gap and unresolved required rows cannot enter the numerator.
4. **Verified boundary or journey coverage:** rows whose every applicable requirement is verified / rows with at least one applicable requirement. A row with one missing requirement is not covered.
5. **Detection and delivery:** verified detectors / required detectors, plus current transport/probe health, reported separately from instrumentation.

Publish counts alongside percentages, broken down by sink, service, deployment mode and surface. Show unknown and exempt counts and exemption reasons. If an applicable denominator is zero, display **not applicable** only after applicability review; otherwise **not measured**. Never display 0% or 100% for zero items. A newly discovered required row enters the denominator immediately.

“100% verified coverage” requires complete scoped discovery, no unknown applicability/ownership, every applicable requirement verified, valid specific exemptions, and current verification of required detection/delivery. It is a structural coverage claim, not a promise that every customer event reaches a vendor.

## Axiom requirements

Axiom is the reliability home. Count operational boundary/stage requirements: actual outcome, attempts/completions, duration where meaningful, bounded failure reason, and missing-result/deadline detection for work expected to finish. Cover auth exits, routes outside `/api`, HTTP 200 stream failures and caught failures whose function execution succeeds. A successful execution of a test that finds a bad user server is an execution success; its product verdict is a separate value.

Use PP-56's versioned outcome contract: `ok`, `failed`, `routine`, `cancelled`, with timeout as a failure reason; stable operation/event identities; service, release, environment, installation type and coarse auth cohort. Keep user impact separate from fault attribution. Unknown failures cannot disappear merely because origin is ambiguous.

Verify shared selectors, required context, deduplication and actual terminal outcomes. Convex `function_execution` is a backstop for thrown errors, not proof that handled outcomes are covered. Aggregate rate monitors count only for requirements they satisfy; they do not automatically satisfy first-failure, latency, per-boundary or deadline requirements.

The target policies are those specified in PP-56: unexpected/unclassified failures on first observation; tested expected refusals or user dependency failures over 15 minutes at >=10 attempts, >=5 failures and >=20% failure rate; existing durable deadlines; two consecutive failed critical probes. Delivery includes opening, reminders and clearing with evidence links. Existing origin-based production rules remain current behavior until migrated with equivalent detection/delivery proof. PP-24 changes no live paging policy.

## Sentry requirements

Count eligible failure classes at each runtime boundary/build that owns diagnostic capture: browser errors/rejections and React failures, server/process failures, Electron main/renderer crashes, SDK-owned reporting failures and eligible Convex exceptions. List handled MCPJam defects requiring diagnostics explicitly; do not send every refusal, warning or test verdict to Sentry.

Use existing capture owners: Inspector server logger/error-origin policy, shared browser/Electron configuration, SDK capture wrapper and Convex's built-in integration. Verify exceptions arrive once with useful stack/error class, truthful environment/release/deployment and build `dist` where relevant. Verify source maps for shipped build variants that publish them, redaction, filters and opt-outs. Do not add a second Convex SDK path merely to satisfy a checklist.

Sentry coverage is the fraction of eligible diagnostic requirements verified, not exceptions observed divided by exceptions that happened: the latter needs an independent ground-truth source. Measure configured sampling and observed controlled-probe delivery separately. No performance-trace requirement is inferred from error coverage; server tracing is deliberately disabled. Incident delivery requirements belong to the Axiom/framework detector inventory, with Sentry diagnostic links where available.

## PostHog requirements

Count journey-stage questions, not clicks or registered event names. Each supported product journey declares its exposure/decision, attempt/admission and authoritative result requirements as applicable, its counting unit (person, organization, attempt, run or iteration), eligible population, entry surfaces and terminal outcomes. Assign explicit applicability for discovery/onboarding, connection/auth, chat/tool execution, evals, swarms, readiness/conformance/benchmarks, integrations and billing; client-only UI decisions need no invented server twin.

Use the shared Inspector event registry and backend typed product-event producer. Verify the authoritative producer, event/property schema, actor/group identity, environment/platform, retry deduplication and query/funnel behavior. Server outcomes are authoritative for accepted work and payment settlement. Client observations supplement them without adding a second attempt. Checkout opened is not payment succeeded; a run accepted is not a run completed.

Critical backend-confirmed outcomes cannot be verified solely through an ad-blockable client event. Client-only measurements declare their eligible consenting population and limits. Respect existing opt-outs and privacy gates. Show sampling, blocker loss and excluded populations separately; never claim all-user delivery from a consenting sample. Use no prompts, credentials, raw URLs, names or free-form user content in new event properties. PostHog is not an incident detector.

## Verification and evidence freshness

For each applicable requirement, prove the producer/adapter behavior, deployed transport/configuration, received event/context and usable query. Where detection is required, prove the actual alert and clearing reach the intended destination. Record timestamps, release/configuration, expected and actual outcomes, query/event references, detector identity and receipt evidence. Mock/unit tests prove behavior, not live delivery. Zero production events proves neither health nor missing instrumentation.

Exercise success, failure, tested routine refusal, cancellation, timeout, handled failure, alternate terminal/recovery writers and duplicate/retry behavior as applicable. Verify opt-out and redaction separately. A stream error inside HTTP 200 must not pass a success check. Privacy-safe controlled staging probes can verify paths; a production claim also requires matching production deployment/configuration and production transport evidence.

Evidence becomes unverified when relevant code, selector, transport, release artifacts, sampling, destination or configuration changes. PP-84's hourly reconciliation and PP-56's heartbeat/probe windows maintain current evidence. Show last check and freshness against those windows. Self-hosted users need not remain online: verify supported release variants through controlled installations, and treat anonymous telemetry as supporting evidence. Opted-out installations stay opted out. Disconnected delivery cannot meet connected-delivery targets.

## Worked examples

| Example | Count and verdict |
| --- | --- |
| Five checkout requirements, four verified | 4/5 verified requirements = 80%; the journey row remains uncovered. This is an illustrative count, not today's measurement. |
| API route logs 5xx; stream fails after HTTP 200 | Completion outcome requirement is a gap even if an aggregate HTTP monitor exists. |
| Cron returns successfully after storing a failed job | Function-execution capture is insufficient; explicit job settlement/deadline detection remains required. |
| SDK library calls a verified server adapter | Caller inheritance may cover execution; SDK-owned detached/reporting failures require separate rows. |
| Browser consumer declines telemetry | Verify opt-out behavior; report population limits. Never bypass consent to reach a numerical target. |
| Sentry receives an exception with an unreadable shipped stack | Delivery passed; diagnostic requirement remains unverified/gap until artifact resolution works. |
| Task closed as a duplicate | Work remains in the coverage denominator under its surviving task. |

## Existing work and remaining milestones

Status evidence below is from Kestral, reviewed on October 14, 2026; these are work records, not current production percentages.

| Milestone | Reuse and remaining work | How it advances 100% |
| --- | --- | --- |
| Define the checklist | PP-24 completes this contract; PP-56 supplies operational scope/policies | Makes denominators and pass conditions explicit for all three sinks |
| List every room and prove transport | PP-80 reuses API-7's October 7 inventory: 497 hosted Inspector routes, 370 Convex HTTP actions, 109 crons; MSI-26 supplies event-to-monitor audit | Adds missing browser/CLI/MCP/desktop/self-hosted and Sentry/product rows; proves delivery |
| Make alarms ring | PP-25 is In Progress; PP-81 proves Ask MCPJam end to end | Verifies failure detection and receipt, including HTTP 200 failures |
| Fill the empty rooms | PP-82, PP-39 and PP-40 cover automatic boundaries and typed events | Converts missing instrumentation into verifiable requirements |
| Finish work that hides failures | PP-83 covers handled outcomes, durable work and recovery paths | Prevents successful functions from concealing failed operations |
| Keep the checklist true | PP-84, PP-38 and PP-26 cover CI, live drift and UI-only monitors | Makes new code and broken live configuration visible |

PP-56 is In Progress; PP-80–PP-84 are To Do. PP-27 (analysis source type) and PP-29 (iteration counts) are In Progress and supply distinct dashboard denominators. PP-37 was closed as a duplicate of API-7.

PP-28 is Done for already shipped `eval_execution_stopped` plus a PAGE detector; its completion note explicitly leaves run-level pass/fail open. PP-36 is Done because one breadth detector was built and four duplicated items moved to PP-41/PP-42, both To Do. Neither closure proves all original requirements verified. PP-26 is To Do; API-7 recorded 66 live-only monitors, 8 code-only monitors and 10 divergent queries at its audit date.

The older MS-1 map and MS-7 triage research are useful completed inputs. MS-2 maps to PP-25, MS-3 to the triage/export work, MS-4 to PP-40, MS-5 to PP-39/PP-82, and MS-8 to the breadth detector plus PP-41/PP-42. MS-6 end-to-end correlation and MS-7's operational decisions still need their own evidence. Their historic research does not satisfy live coverage gates.

## Completion criteria for PP-24

The definition is complete when scope/discovery, sink-specific denominators, applicability/exemptions, arithmetic, proof gates, evidence freshness and work ownership are explicit, and worked cases distinguish partial coverage, no data, privacy exclusions and duplicate task closure. All are specified above. PP-80 can now build the measured inventory; implementation and production verification remain in the linked tasks. Do not publish a current total percentage before that inventory exists.

## Source references

- [PP-56 operational framework](https://app.kestral.ai/workspace/yhNILB2/task/1O2sgFk2), [PP-80 inventory](https://app.kestral.ai/workspace/yhNILB2/task/1PfTevfV), [API-7 audit](https://app.kestral.ai/workspace/yhNILB2/task/1NXIIEEN).
- [PP-28 completion and remaining gap](https://app.kestral.ai/workspace/yhNILB2/task/1OCyCLDC), [PP-36 duplicate closure](https://app.kestral.ai/workspace/yhNILB2/task/1OD2qab9).
- Inspector [server reporting policy](../mcpjam-inspector/docs/server-error-reporting.md), [Sentry configuration](../mcpjam-inspector/shared/sentry-config.ts), [event registry](../mcpjam-inspector/shared/analytics-events.ts), [SDK Sentry capture](../sdk/src/sentry.ts).
- Backend `docs/operational-issues.md`, `docs/posthog-backend.md`, `convex/lib/productAnalytics.ts`; these describe current behavior, while PP-56 specifies the target rollout.
