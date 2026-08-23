---
"@mcpjam/cli": patch
"@mcpjam/sdk": patch
---

Add atomic JSON and JUnit report files for completed hosted eval runs and gates.

JUnit rendering now escapes the characters XML 1.0 forbids outright (most C0
controls, unpaired surrogates) rather than emitting them verbatim. This applies
to every structured reporter, not only the new eval one: previously a control
character in any failure message produced a report file no JUnit parser would
read.
