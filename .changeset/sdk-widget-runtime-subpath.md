---
"@mcpjam/sdk": minor
"@mcpjam/inspector": patch
---

Add a `@mcpjam/sdk/widget-runtime` subpath exposing the framework-free MCP-Apps
widget building blocks: SEP-1865 tool-visibility helpers
(`getToolVisibility` / `isVisibleToModelOnly` / `isVisibleToAppOnly`) and the
diagnostic `LoggingTransport`. The inspector now sources these from the SDK via
back-compat re-export shims at their original paths. No behavior change.
