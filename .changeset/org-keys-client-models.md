---
"@mcpjam/inspector": patch
---

Preserve the organization provider connection when saving a client model, whether or not organization keys are required. A picked organization model now saves with its connection and reloads without "isn't allowed here", and a client created from a template starts on an organization model instead of the template's hosted one.
