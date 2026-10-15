---
"@mcpjam/inspector": patch
---

A host whose model id is outside the hosted catalog is stored with a legacy selection (`{ source: "legacy", modelId }`). The hosts page editor now types that shape honestly and treats it as no selection: picking a reasoning effort mints a proper selection from the model row instead of writing settings onto the legacy object, which the backend refuses. The shared picker lookup resolves a stored legacy selection only to an own-key row, never to the hosted row of the same id, and on the hosts page only when exactly one such row matches; a compare card keeps rendering on the first enabled own-key row.
