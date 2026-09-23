---
"@mcpjam/sdk": patch
---

Rename the User Testing permalink's label from "Open scenario" to "Open study", matching what the product has called the object since the create flow was rewritten. The resource type key, the route it builds and every id stay exactly as they were, so a permalink minted before this change still resolves and any caller switching on the type is unaffected.
