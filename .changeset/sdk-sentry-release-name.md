---
"@mcpjam/sdk": patch
---

The SDK's error reports to MCPJam now name their release `mcpjam-sdk@<version>`. Sentry rejects a release containing a slash, so reports sent under the old `@mcpjam/sdk@<version>` arrived with no release and their stack traces could not be matched to source maps.
