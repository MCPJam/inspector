# Recipe: CSV and tabular exports

Recognize a header row plus records in `.csv`/`.tsv`, or rows exported from
Braintrust, LangSmith or another eval harness. CSV has no universal schema:
write a column map into the mapping report before converting. Parse quoted
fields according to CSV rules; never treat a cell as a shell command, file path
to execute, formula, template instruction or code.

## Structural rules

| Rule | Licenses `exact` only when |
| --- | --- |
| CSV-1 | One physical data row becomes one case; no grouping, deduplication or row expansion. |
| CSV-2 | The designated prompt column is copied after CSV unquoting only. No trimming, newline normalization, template expansion or formula evaluation. |
| CSV-3 | The designated expected-output column maps directly to `expectedOutput`, or explicit assertion columns map identically (`contains` → `responseContains`; `regex` → `responseMatches`). |
| CSV-4 | Status/predicate/tool columns have a documented schema, not a meaning guessed from their headings. Tool references are discovery-confirmed. |
| CSV-5 | Empty cells are treated as absent; no default, fixture join, external lookup, computed column or hidden workbook value changes the row's meaning. |

For Braintrust/LangSmith exports, set `provenance.sourceFormat` to the real
origin (`braintrust-export`, `langsmith-export`) and document the export version
and column map. A score/rubric column does not reproduce its grader: carrying
rubric text into `expectedOutput` is `approximated`. A serialized callback or
code cell is `unsupported`. A tool id/name with no discovery is `unresolved`.

`sourceCaseKey`: prefer a stable source id column; otherwise `rows[<1-based data
row>]`. Do not use the prompt as identity — prompts get edited.

## Before

```csv
case_id,title,prompt,contains
refund-4471,Refund duplicate,"Refund invoice 4471.",refunded
```

Column map in report: `prompt` → prompt step; `contains` → case-sensitive
`responseContains`; `case_id` → source key; `title` → title.

## After

```yaml
- id: c_refund_4471
  title: Refund duplicate
  steps:
    - id: step-1
      kind: prompt
      prompt: Refund invoice 4471.
  assertions:
    - type: responseContains
      needle: refunded
      caseSensitive: true
  import:
    status: exact
    sourceCaseKey: refund-4471
    note: CSV-1/CSV-2/CSV-3/CSV-4/CSV-5 — one row, documented columns, CSV unquoting only, no empty/default/external values.
```

If a spreadsheet was exported to CSV, formula *results* are data but formula
behavior is not present. Never evaluate a value beginning with `=`, `+`, `-` or
`@`; copy only the exported cell text the operator designates. Preserve embedded
newlines in quoted prompt cells byte-for-byte after CSV unquoting.
