# UVC acceptance corpus

Manually reviewed trajectories and counterexamples for the user-value-chain
check kinds (plan step C0). Every file is one corpus item: a transcript in the
shape `evaluatePredicates` consumes, plus the labels a human assigned to it.

## Why it exists

A deterministic implementation does not make a heuristic an objective quality
test. Several of the kinds this corpus covers are heuristics — a pattern that
can be right about what it saw and still be wrong about what it means. The
corpus is where that distinction is written down, so a kind cannot enter the
recommended seed on the strength of "the code runs".

## Two labels, because they answer different questions

Every expectation carries both:

- **`observation`** — did the detector fire correctly? `"pass"`, `"fail"`, or
  `"error"` (no evidence; the check could not be scored). This grades the
  detector against what is literally in the transcript. "Ends with a question"
  is *true* of "Would you like a breakdown?".
- **`relevance`** — is this a finding a server developer should see here?
  `"useful"`, `"neutral"`, or `"misleading"`. For that same offer-ending
  answer the label is `"misleading"`: nothing is wrong with the server.

A row that does not fire is `"neutral"` by construction — the harness enforces
that, so `relevance` never quietly grades a non-event.

## The bar for the recommended seed

A kind may join `RECOMMENDED_DEFAULT_PREDICATES` (plan step C7) only at **zero
detector errors and zero misleading firings** across this corpus.

Zero here is a regression bar, not proof of general accuracy. The corpus grows
with every counterexample found in use, and a kind that starts firing
misleadingly on a newly added item leaves the seed.

## Item shape

```jsonc
{
  "id": "kebab-case-id",              // must equal the filename stem
  "title": "one line",
  "rationale": "why this item is in the corpus",
  "transcript": { /* IterationTranscript */ },
  "expect": [
    {
      "predicate": { "type": "noEndingQuestion" },
      "observation": "fail",
      "relevance": "misleading",
      "note": "the question is an offer, not a request for missing input"
    }
  ]
}
```

Expectations naming a predicate kind this SDK does not implement yet are
reported as `notImplemented` coverage rather than failing — the corpus is
authored ahead of the detectors on purpose, and each kind's step turns its
skips into assertions.
