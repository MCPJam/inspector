---
"@mcpjam/inspector": patch
"@mcpjam/sdk": patch
---

A `/v1` client write from a caller that doesn't send `x-mcpjam-host-config-features` (released SDKs and CLIs) now keeps the client's stored `modelVisibleMcpToolResults.structuredContent` rule. Such callers read the config without the rule, so writing it back used to erase it. Under a client rule, an embedded text resource with an image type, such as an SVG, now reaches the model as JSON instead of an image omission marker.
