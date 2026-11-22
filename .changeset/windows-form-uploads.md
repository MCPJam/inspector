---
"@mcpjam/inspector": patch
---

On Windows, attaching a file to a local server's form no longer fails with a server error. The private upload folder was refused because Windows reports no POSIX permission bits and cannot flush a directory handle. Uploads are still refused when `TEMP` points outside your user profile, because the inspector cannot confirm that folder is private to you.
