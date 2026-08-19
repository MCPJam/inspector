---
"@mcpjam/sdk": minor
"@mcpjam/inspector": minor
---

Eval cases are authored in batches, and every case gets a declared identity.

Every first-party authoring path used to loop the platform's per-case create
mutation: `authorEvalSuite` once per case, generation once per draft, the public
`POST …/cases` route once per call. An agent converting a repo's 40 test files
made 40 sequential round trips, each its own transaction, with no way to say
"these 40 cases" as one write. All of them now go through the platform's batch
mutation, which validates every case before writing any of them and reports the
outcome per case.

## `create_eval_cases` / `POST …/cases/batch`

The bulk form of `create_eval_case`, taking up to 100 cases per call. Each entry
takes exactly the fields a single create takes, because it *is* the single
create repeated — not a second contract with its own spelling of a case.

The response is a partial outcome by design, and says so rather than implying
it:

```jsonc
{
  "created": [{ "index": 0, "id": "…", "declaredId": "c_…", "title": "lists files", "replayed": false }],
  "failed":  [{ "index": 1, "code": "DUPLICATE_CONTENT", "message": "…" }],
  "duplicatePolicy": { "requestedPolicy": "blcok", "effectivePolicy": "block", "coerced": true }
}
```

Both arrays carry the `index` of the entry they describe, so a caller lines
results up against the list it sent. It is `201` even when `failed` is non-empty:
the cases in `created` really were written, and a `4xx` would tell the caller to
retry writes that already landed. `duplicatePolicy` defaults to `block`; `warn`
and `create_anyway` author a duplicate but require an `overrideReason`, which is
recorded on the case's revision. An unrecognized policy coerces to `block` and
reports the coercion — a typo should not look like a platform that refuses cases
for no reason.

The 100-case cap is deliberately smaller than a suite file's 500-case limit. The
two answer different questions — a file is an authored artifact, a call is bound
by request size — so a maximal file uploads in several calls. Do not align them.

## Cases carry a declared id

`create_eval_case` and `POST …/cases` accept an optional `id`: the identity the
case answers to in a suite file, an import, or a CLI argument. Callers mint it
(`mintCaseId` from `@mcpjam/sdk/contract`); the platform validates the charset
and suite-scoped uniqueness and never derives one, because an id derived from a
case's content or position is the content-hash identity declared ids exist to
retire. Omitting it still works — this server mints one — so no existing caller
has to change.

`POST …/cases` now writes through the same batch mutation with a single entry,
so the single and bulk paths cannot drift into two meanings of "author a case".
One consequence is worth knowing before you upgrade: that route now gets the
batch default `duplicatePolicy: block`, so creating a case whose definition
already exists in the suite returns `409 CONFLICT` instead of authoring a second
copy. To author one deliberately, send it through `…/cases/batch` with
`duplicatePolicy` and an `overrideReason` — the reason is what gets recorded.
The hosted editor is unaffected; it writes through the platform mutation
directly and keeps its existing behaviour.

The declared id reads back as `declaredId` on the case, deliberately NOT folded
into `id`:
that field is the platform row id every case route takes as its path parameter
and every selector resolves against, and one name for two identities would break
each of them. A declared id is also never written into a case's storage key,
which stays the platform's own random `ui_*` value.

## Generation reads both case shapes

`generateTestCases` now accepts a versioned union from the backend: no
`shapeVersion` is today's case, and `shapeVersion: "wave0"` is the converged
shape where `steps[]` replaces `query`/`expectedToolCalls`/`promptTurns` and
`repetitions` replaces `runs`. A Wave-0 case still persists the same legacy
display columns, derived from its steps, so equivalent authored intent stores
equivalently whichever shape produced it.

This lands before the backend emits the new shape on purpose. A consumer that
already reads both is what makes the producer's change non-breaking, and lets
either side roll back while both are deployed. The legacy branch is temporary
and marked for removal once the compatibility window closes.
