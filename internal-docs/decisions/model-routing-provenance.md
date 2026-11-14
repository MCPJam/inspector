# Model routing provenance (PR 5148)

## Decision

Keep `ModelDefinition.hosted` as the additive routing discriminator at the
picker/server boundary. Do not change global ID canonicalization or stamp
`SUPPORTED_MODELS` itself: old host pins also resolve through that catalog.

- `false`: explicit own-provider selection; use the existing credential-checked
  BYOK path, even if this ID also exists in the hosted catalog.
- `true` or omitted: require the existing provider-aware hosted catalog match.
  A request cannot make an unknown model eligible for MCPJam credits.
- All picker-built BYOK rows carry `false`, including dynamic provider lists.
  Stamp the complete BYOK collection at its return boundary so newly added
  providers inherit the rule. Preserve the hosted collection unchanged.
- Equal IDs are not sufficient for a single-selection no-op. Compare provider,
  custom provider name and the routing flag too. In particular, absent and
  false are different server contracts.
- Explicit org-provider list matches also carry `false`. Otherwise an
  OpenRouter selection whose ID matches the hosted catalog can lose its source
  when lifted from a host config.
- Synthetic source resolution uses the same classifier as interactive dispatch
  and harness admission. This deliberately corrects the previous provider-blind
  synthetic behavior for bare hosted aliases; explicit false still takes BYOK.
- Swarm targets preserve an optional `hosted` value from their immutable input
  snapshot into the resolved model and harness admission. Never fetch a live
  host to recover routing for a pinned run, and never mutate a catalog object.

## Persistence boundary and rollout

This repository's host editor currently persists `modelId` alone. SDK
`HostConfigV2`, scenario runtime DTOs and eval case records likewise do not
provide a complete model selection. The backend `materializeHostSpec` producer
is not in this repository. Adding an optional field to `PinnedHostExecutionSpec`
is consumer support, not proof that the backend stores or sends it.

Complete saved-host support requires a coordinated, versioned contract change
across the SDK host schema/canonicalizer, host editor, backend validation and
materialization, scenario runtime config and eval records. Persist provider,
custom-provider identity and credential source alongside the model ID as one
selection; then carry it through every reconstruction boundary. Old snapshots
must keep their existing fallback, and a host-authoritative selection must not
inherit an override from an unrelated request model. Do not backfill false from
current key availability: that would silently change existing billing choices.

This PR fixes model definitions carrying explicit selection provenance and
prepares the swarm consumer. It does not claim to migrate saved hosts, eval
records, ID-only selection storage, or multi-model comparison identity.

## Validation

Regression tests were added and observed failing before implementation for
synthetic bare-ID classification, immutable builder overrides, dynamic BYOK
picker rows, swarm propagation and same-ID provider selection. Coverage also
checks that BYOK pinned aliases cannot provision a brokered harness, while
legacy unflagged pins and catalog eligibility retain their fallback behavior.

Final checks: 437 tests passed across 18 relevant client/server suites; client
production typecheck and inspector pretest (including browserd bundle freshness)
passed. Server typecheck remains red with 1,003 diagnostics, identical to the
untouched PR head under the same dependency setup after normalizing line numbers.

## Store once: the saved selection decides (PLB-162)

The persistence boundary above is now complete. The saved `ModelSelection` is
the one stored copy of a config's model (host configs, environment overrides,
case `models[]` entries, judges, personas); records of what ran keep their
plain model string. Routing reads it first (`server/utils/selection-rail.ts`):

| Saved selection             | Rail                                     | Who pays          |
| --------------------------- | ---------------------------------------- | ----------------- |
| none (an older row)         | today's path (`isHostedModelDefinition`) | hosted list check |
| `source: "hosted"`          | MCPJam `/stream`                         | MCPJam credits    |
| `source: "org"`             | the org connection                       | the organization  |
| `source: "local"`           | the caller's own provider                | own key           |
| `source: "legacy"` (stored) | own key only                             | never MCPJam      |

The backend chooses a selection for every bare id ONCE, on save and in a
one-time backfill, by hosted-catalog membership read from its own tables
(ever hosted ⇒ `hosted`, else the stored `legacy` form) and marks it
`origin: "backfill"`. It never moves a call onto MCPJam credits and still
never infers anything from current key availability. Rows the backfill has
not labelled yet keep the hosted-list check unchanged; retiring that check and
`shared/hosted-model-ids.generated.ts` is the follow-up once the backfill ran
on prod.

Two choices of one model are compared by `comparisonKey` (the bare model id
for a default selection, so existing history keeps its keys; the model id plus
the canonical selection otherwise), and labels show only what differs
(`selectionDistinguishers`).
