---
"@mcpjam/sdk": minor
"@mcpjam/cli": minor
---

Suite files get a loader, and the CLI gets `eval validate` and `eval export`.

The suite-file contract has existed for a while as schemas and a generated JSON
Schema, and its own module says outright that it is the contract and not the
loader: "reading YAML, resolving defaults onto cases, and `eval validate` are a
separate concern that consumes these schemas". That separate concern is what
this adds.

## `loadEvalSuiteFile` / `serializeEvalSuiteFile` (`@mcpjam/sdk`)

Text in, text out. Pure and browser-safe — no `node:fs`, no `node:path`, no
`process` — because three consumers need it and only one of them is a CLI: this
CLI, the importer that converts foreign eval formats into suite files, and a
future `validate_eval_suite` agent tool.

YAML is canonical and JSON is accepted, through **one** parser and no format
sniffing: JSON is a subset of YAML 1.2, so a sniffing branch would only be a
second code path that could disagree with the first about the same bytes. A
multi-document stream is refused rather than read as its first document.

Input is capped at 1,048,576 bytes of UTF-8 and is never truncated. The cap is
measured in bytes, not `String.length`, for the reason the server's
`mcpjam.yaml` parser already spells out: code units undercount multi-byte text,
so a length check admits inputs larger than the bound it is meant to be.

The loader returns **both** the validated authored value and a resolved value
with the documented defaults applied — `minCompletionRate` 0.8,
`maxEvaluatorErrorRate` 0.1, `captureLevel` `full`, and per-case model /
repetitions / pass threshold. The serializer accepts only the AUTHORED value,
and the two are different TypeScript types, which is what makes it structurally
impossible for a resolved default to be written back into a file. That is the
contract's own rule 1 ("no `.default()` anywhere") enforced one layer up: an
unchanged suite round-trips with an empty diff.

Failures are findings, never exceptions — a validator that throws cannot report
more than the first thing it found. Each finding carries a stable machine code,
a field path (as segments and as a rendered `cases[3].steps[0].id`), a message,
and a source location when the YAML parser had one. They are sorted into
document order rather than emitted in the validator's traversal order, so two
runs over the same bytes produce byte-identical output.

Exported from `@mcpjam/sdk`, deliberately NOT from `@mcpjam/sdk/contract`: that
subpath is dependency-light and browser-bundled on purpose, and routing the
loader through it would pull `yaml` into every client bundle that imports the
contract for its types.

## `mcpjam eval validate --file <path>`

Offline. No auth, no network, no `--project` — it builds no API client and reads
no API key. Exit `0` valid, `1` parsed-but-contract-invalid with every finding
reported, `2` when nothing was validated at all (unreadable path, over the cap,
malformed YAML). The difference between 1 and 2 is the point: a script that
retries on 2 and opens a ticket on 1 is doing the right thing with both.

It deliberately does not re-resolve tool names, server references or fixtures
against a project's live discovery. That is project-aware validation, it needs a
network round trip, and it belongs to a later step — which is why this command
takes no project at all rather than taking one and ignoring it. "Valid" here
means "a valid suite file", never "this will run", and the docs say so.

## `mcpjam eval export --suite <id-or-name>`

Fetches a hosted suite with the same operation pair `eval pull` uses, including
its fail-closed pagination guard, and writes `.mcpjam/evals/<suite-id>.yaml` —
the suite's stable, path-safe identity, never its display name, so a rename does
not leave a second file behind.

**It refuses rather than approximating.** A suite file cannot express everything
a hosted suite can — host attachments, attached project environments, a pinned
sandbox image, an execution system prompt or temperature, LLM-as-judge grading,
non-default match options, an iterations floor that raises a case, a
compare-across-models case, a scenario-bound case, `replace`/`extend` check
overrides. Each of those emits an `UNSUPPORTED_SUITE_EXPORT` finding and **no
file is written at all** — not a partial one, not one with a warning comment. A
file that quietly dropped a host attachment still parses, still runs, and
measures something other than what the dashboard measures while carrying the
dashboard's suite id, so its results join the same history. There is no comment
that fixes that.

Two of the shapes a suite file reuses are open on purpose (a tool call's
`arguments`, and predicates), and an open zod object strips unknown keys rather
than refusing them. So "the candidate validated" is not proof that nothing was
lost. The proof is a deep-equality check after validation: anything the
validator quietly removed surfaces as a finding naming the path.

Case identity is never freshly minted. A case exports under its declared id, or
under its platform row id, or the export refuses. The dashboard's own exporter
mints one as a fallback and is right to — its normal input is a draft that may
have no identity yet. A CLI export of a persisted suite always has a row id, so
a mint here would not be a fallback: it would be a brand-new identity for a case
that already has one, minted afresh on every single export. That is the history
fork declared ids exist to prevent.

The file is written through a sibling temp file, an `fsync` and a `rename` —
the corpus lock's mechanism, now extracted and shared, with the lock's own
behaviour unchanged. It never passes through `writeJsonArtifact`, whose
telemetry redaction would silently alter authored content in a file that is then
read back.

## `eval pull` is legacy now

The suite file is the on-disk format going forward. `eval pull` and
`mcpjam-evals.lock.json` survive for exactly one reason — they are the
documented consumption path for `@mcpjam/vitest` (pull once, commit the lock,
`loadCorpusFromLock`) — and its help text now says so and points at
`eval export`. Retiring it is a follow-up gated on `@mcpjam/vitest` adopting the
new loader; nothing here teaches the lock any new capability.
