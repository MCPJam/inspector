---
"@mcpjam/sdk": minor
---

`@mcpjam/sdk/mocks` now exports `findInvalidSchemas`, which finds the tools of a mock definition whose input or output schema is not valid JSON Schema, such as `type: "bogus-type"` or `required: "id"`. Each issue has the code `invalid_schema`, the field path and what to change.
