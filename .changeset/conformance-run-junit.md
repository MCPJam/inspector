---
"@mcpjam/sdk": minor
"@mcpjam/cli": patch
---

`mcpjam conformance run --reporter junit-xml` writes one well-formed JUnit document covering every suite, including in CI, where it used to print JSON. A suite that could not run gets a skipped testsuite in the file, and stderr says why. The SDK exports `renderConformanceRunJUnitXml` for a `runConformance` report.
