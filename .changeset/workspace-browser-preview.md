---
"@mcpjam/inspector": minor
---

In hosted chats where the agent's shell runs on a separate computer, Browser now opens apps running on that computer at `http://localhost:<port>`. The page keeps its localhost origin, hot reload works, and requests from other sites are refused.
