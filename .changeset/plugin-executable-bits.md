---
"@mcpjam/inspector": patch
---

A plugin's packaged executable now runs directly when the plugin comes from a ZIP: the local plugin cache keeps the ZIP's executable bit (0755, never a special bit) and a hosted box gets the same bits after upload, so a component launched as `bin/server` no longer fails with `EACCES`. A folder import still carries no executable bits. Cache entries and box copies made before this are replaced once. The import preflight reads a ZIP's modes too, so its execution digest matches the backend's.
