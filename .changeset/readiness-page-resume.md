---
"@mcpjam/inspector": patch
---

A hosted readiness run that stopped on the server before it finished is resumed by the person who started it while their Readiness or Conformance page follows it, instead of waiting until it fails. The run's node now claims it before it starts, so a run's status says whether it is executing, and a Claude run that could not reach its server no longer asks for AI observations.
