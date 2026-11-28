---
"@mcpjam/inspector": patch
---

On Windows, opening a saved local file in a writable App viewer no longer fails with `PLUGIN_FILE_BINDING_INVALID`. The file's path is now spelled with Windows separators, and a drive-letter path counts as absolute.
