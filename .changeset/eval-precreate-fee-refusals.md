---
"@mcpjam/inspector": patch
---

Starting an eval when the organization is out of platform credits or over its spend budget now answers with the backend's reason (403 or 429) instead of a 500 asking to try again.
