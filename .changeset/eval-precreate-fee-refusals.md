---
"@mcpjam/inspector": patch
---

Starting an eval when the organization is out of platform credits or over its spend budget now answers 403 with the backend's reason instead of a 500 asking to try again.
