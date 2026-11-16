---
"@mcpjam/sdk": minor
---

Add `parseModelCallCostEvidence` and `toModelCallCostEvidence`. The parser reads per-call cost evidence from a stream finish, a stored span or a usage row and returns undefined for anything incoherent, such as an unavailable result that carries an amount or a complete one without it, so a malformed value shows as no cost rather than a wrong number. `toModelCallCostEvidence` attaches the usage, usage source and funding a priced call was computed from.
