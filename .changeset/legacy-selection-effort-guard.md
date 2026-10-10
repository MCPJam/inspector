---
"@mcpjam/inspector": patch
---

A host whose model id is outside the hosted catalog is stored with a legacy selection (`{ source: "legacy", modelId }`). The hosts page editor now types that shape honestly and treats it as no selection: picking a reasoning effort mints a proper selection from the model row instead of writing settings onto the legacy object, which the backend refuses.
