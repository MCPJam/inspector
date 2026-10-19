---
"@mcpjam/sdk": patch
---

A ZIP entry typed as a link is now refused as a link (`PATH_LINK_ENTRY`) even when its name ends in `/`, as the backend's reader already does, instead of being listed as an empty directory.
