---
"@mcpjam/inspector": patch
---

Cap swarm persona turns at 10 tool steps instead of inheriting the Playground's 30. Every step of a turn resends every tool result the turn has produced, so the cap bounds turn time and tokens together; on dev, uncapped persona turns against the MCPJam server reached 677k to 881k tokens and tripped the 6-minute turn budget. Scenario (User Testing) sessions keep the engine default.
