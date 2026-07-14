---
"@mcpjam/inspector": patch
"@mcpjam/sdk": patch
---

Restore backend-backed host catalog flows and shared image-support hydration.

- Use the backend host catalog/templates for project host create, update, delete, and detail routes.
- Hydrate backend image-support facts into concrete host config image fields for SDK fallback catalogs.
- Export the shared image-support mapping helper for catalog seeding.
