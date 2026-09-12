---
"@mcpjam/inspector": patch
---

Fix comparison columns leaving Browser tools off for a guest who had already granted browser permission on the device. A column with no explicit per-client setting now follows that device consent for guests, while an authenticated user's columns keep following their saved client setting.
