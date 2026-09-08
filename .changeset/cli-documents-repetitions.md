---
"@mcpjam/cli": minor
---

`--repetitions` is documented, and `description-experiment start` accepts it

**The CLI reference taught the deprecated spelling.** `--repetitions` is the
canonical flag on `cloud eval run` and `cloud eval cases run` and
`--iterations` is its deprecated alias — that is what `--help` prints — but the
reference documented only `--iterations`, and `--repetitions` did not appear in
it as a flag at all.

`cloud eval description-experiment start` had the same word pointing the other
way: `--iterations` was its CANONICAL flag, with help text that read
"Repetitions", one command over from where `--iterations` means "please stop".
It now takes `--repetitions`, keeps `--iterations` working as a deprecated
alias, and passing both is a usage error rather than a silent precedence rule.

`--max-trials` beside it is unchanged: it caps the product of cases and
repetitions, which genuinely is trials.
