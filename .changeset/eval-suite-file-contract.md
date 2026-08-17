---
"@mcpjam/sdk": major
---

Canonical contract types for eval suites: a versioned suite-file schema, the
step union's new home, declared case identity, and the Wave-0 chain vocabulary.

## BREAKING: `EvalTestConfig.id` is now required

A case's identity used to be its `name`. That meant renaming a test forked its
hosted history — the dashboard started a fresh series and orphaned the old one —
because the backend derives a case key from the case's content and title when no
explicit identity is present. `id` separates the two: history joins on `id`, and
`name` is free to change.

```diff
 const test = new EvalTest({
+  id: "c_V1StGXR8Z5jdHi6Bmy",
   name: "refunds a duplicate charge",
   test: async (executor) => { … },
 });
```

Mint one ONCE and commit the literal:

```ts
import { mintCaseId } from "@mcpjam/sdk/contract";
console.log(mintCaseId()); // c_V1StGXR8Z5jdHi6Bmy — paste this in
```

Any URL-safe string of 1–128 characters (`A-Z a-z 0-9 _ -`) is accepted, so an id
you already maintain — a hosted case id, a ticket number, a slug — works as-is;
the `c_` prefix is a grep convenience, not a rule. Constructing an `EvalTest`
without an `id` throws, and the error carries a freshly minted id to paste. The
id is deliberately NOT derived from `name` when absent: deriving it would
recreate the exact bug being retired while looking like it worked. Do not call
`mintCaseId()` inline either — an id regenerated per run is not an identity.

`EvalSuite.add` now also rejects duplicate ids. Duplicate names always collided
visibly (the suite keys results by name); duplicate ids do not, and two cases
sharing one silently merge into a single case's history.

`externalCaseId` is unchanged and keeps its live wire semantics — it remains the
hosted join key. **Nothing about the upload payload changes in this release**:
`id` is threaded through types and constructors only, so published 4.x clients
and every hosted surface behave exactly as before.

## New: the eval suite file (`@mcpjam/sdk/contract`)

`evalSuiteFileSchema` validates a whole suite as one declarative document:
`schemaVersion`, `mode`, `reportingMode`, `suite`, `target`, `defaults`
(model, repetitions, `passThreshold`, `validity`, `toolPolicy`, `captureLevel`),
optional import `provenance`, and `cases[]` — each case carrying steps reused
verbatim from the canonical step union, optional predicate `assertions`, per-case
overrides, and an optional `import` record.

Three properties are load-bearing:

- **Reserved values are validation ERRORS, never accepted-and-ignored.** `mode:
  "serverContract"`, `reportingMode: "restricted" | "summary"` and
  `captureLevel: "metadataOnly" | "none"` name capabilities that do not exist
  yet. A file asking for reduced capture and getting full capture would be a
  privacy failure with a paper trail claiming otherwise, so each is a `z.literal`
  whose error names the reserved value and the v1 stance — and the generated JSON
  Schema emits `const`, rejecting them structurally too.
- **No `.default()` anywhere.** An omitted field stays omitted, so a parsed file
  round-trips byte-stably through canonical JSON and the diff of an unchanged
  suite is empty. Default *semantics* are documented in JSDoc beside each field
  (`validity.minCompletionRate` 0.8, `maxEvaluatorErrorRate` 0.1) and applied by
  a loader, not materialized here.
- **Every object the file declares is `.strict()`.** An importer that invents or
  mis-maps a suite-level field fails loudly instead of having it dropped on the
  floor — and it matches Convex `v.object`, which rejects unknown fields. The
  reused step and predicate schemas are the stated exception: they are the
  shared authoring union, they strip unknown keys today, and making them strict
  is a semantic change to a cross-repo mirrored schema rather than something a
  new file format should do as a side effect.

`schemaVersion` is `const "1"`: additive optional fields stay within `"1"`, a
breaking revision becomes `"2"`, and a v1 validator handed a `"2"` file says the
CLI/SDK needs upgrading rather than sending someone to edit a correct file.

Shipped alongside: `eval-suite.schema.json` (draft 2020-12, `$id`
`https://mcpjam.com/schemas/eval-suite/v1.json`) plus the same document exported
as `evalSuiteFileJsonSchema` for consumers without a JSON import path. Both are
generated from the zod source and a test byte-compares them against a fresh
generation, so they can never be hand-edited into disagreement.

The schema describes what is ACCEPTED (`io: "input"`), not what zod returns, so
the two validators agree on which files they accept — including where both are
permissive. The element locator's "at least one of role/text/css/testId" rule is
a refinement that would not project, so the generator encodes it as an `anyOf`
of `required`; leaving it out would let an editor green-light a `target: {}` the
SDK then rejects, and tooling passing while the runtime fails is the worst
direction for a divergence. What genuinely cannot be expressed in JSON Schema —
unique case ids, unique step ids within a case, an `import` block requiring
top-level `provenance`, and the serialized-size cap on tool-call arguments —
stays zod-only, and the fixtures annotate every reject row with whether the JSON
Schema must catch it too.

## New: the step union's canonical home is now the SDK

`TestStep` and everything defining it — the four step schemas
(`prompt`/`toolCall`/`interact`/`assert`), the interact actions, the widget
assertions, `elementLocatorSchema`, the text/wait/args/render-timeout caps and
the narrowing helpers — now live in `@mcpjam/sdk/contract`. They previously lived
in the inspector app, which the SDK cannot import, so a suite-file schema in the
SDK would have needed a hand-mirrored second copy. There is still exactly one
definition; the inspector re-exports it and a test asserts referential identity
so a copy can never quietly replace the re-export.

## New: the user-value chain vocabulary

`USER_VALUE_STAGES`, `STAGE_STATES`, `FAILURE_CATEGORIES`, `ITERATION_STATUSES`
and `IMPORT_MAPPING_STATUSES` as const arrays, derived types and zod enums.
`USER_VALUE_STAGES` order is **normative** — "not reached" is derived from
position in it, so sorting the array changes which stages a failure is reported
to have blocked. Stage states are strings with no numeric encoding: `notReached`,
`notMeasured` and `notApplicable` are three different reasons there is no
verdict, and collapsing them is how "we never checked" gets rendered as "it
passed". `ITERATION_STATUSES` extends the six statuses the backend persists with
`setup_failed` (our environment broke, not the server's) and `skipped`
(deliberately not run, unlike `cancelled`).

## New: `@mcpjam/sdk/contract` identity helpers

`opaqueIdSchema` (`^[A-Za-z0-9_-]{1,128}$` — URL, path and CLI safe), plus
`mintCaseId()` / `mintSuiteId()` using `crypto.getRandomValues`. Validators never
require our prefix: ids are opaque, and demanding `c_` would reject every id the
platform has already issued.
