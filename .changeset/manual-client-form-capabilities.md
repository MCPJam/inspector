---
"@mcpjam/sdk": patch
"@mcpjam/inspector": patch
---

Honor the selected client's Forms setting for local manual calls, preserving explicit server capability overrides and withholding modern-only form claims from legacy connections. Keep default local connection capabilities additive so modern form support can apply after negotiation.
