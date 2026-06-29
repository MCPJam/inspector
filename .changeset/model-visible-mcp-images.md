---
"@mcpjam/sdk": minor
"@mcpjam/inspector": minor
---

Expose MCP tool-returned images through host-config-controlled model output.

Adds model-visible conversion for direct image blocks, embedded image resources, and linked image resources behind the structured host config policy `modelVisibleMcpToolResults`. Also preserves the policy through Host JSON normalization and caps image conversion by per-image size, image count, linked resource reads, and aggregate decoded bytes.

Adds host-config-controlled UI rendering for MCP tool-returned images via `mcpToolResultImageRendering`, with `inline`, `panel`, and `none` modes. The inspector can render direct images, embedded image resources, and linked image resources for humans while keeping raw MCP JSON available.
