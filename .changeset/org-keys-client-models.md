---
"@mcpjam/inspector": patch
---

Keep clients on the organization's own provider while it requires its own keys. A picked organization model now saves with its connection and reloads without "isn't allowed here", and a client created from a template starts on an organization model instead of the template's hosted one.
