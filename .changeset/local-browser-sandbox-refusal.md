---
"@mcpjam/inspector": patch
---

When Chromium can't start its sandbox (since Ubuntu 24.04, AppArmor restricts the user namespaces it needs by default), the local Browser now says so and links the fix. Any other Chromium launch failure now shows its real first line. Neither is reported as "Invalid project for the local browser" any more.
