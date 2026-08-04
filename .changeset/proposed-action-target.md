---
"@mcpjam/sdk": minor
---

`ProposedAction` gains an optional `target` (`{ type, selector }`, new `ProposedActionTarget` export) naming the resource a proposal is about, in the proposing operation's own selector vocabulary. Hosts use it to correlate proposals with other turn output — e.g. suppressing a duplicate run affordance on exactly the created suite a run proposal already targets. Absent on older servers and untargeted operations; treat absence as match-unknown.
