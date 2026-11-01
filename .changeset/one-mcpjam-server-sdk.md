---
"@mcpjam/sdk": minor
---

Choose the MCPJam server for every Node entry point by one order: an explicit `baseUrl`, then `MCPJAM_API_URL` or `MCPJAM_BASE_URL`, then the saved login's server when the saved login is the credential, then MCPJam Cloud. Behavior changes:

- A `baseUrl`, `MCPJAM_API_URL` or `MCPJAM_BASE_URL` with credentials, a query or a fragment now throws `API_URL_INVALID`. The message masks those parts and does not repeat a value that is not a URL.
- `MCPJAM_API_URL` is now honored by eval reporting, conformance uploads and eval runs, which read only `MCPJAM_BASE_URL` before. Setting the two to different servers throws `McpjamDeploymentError` (`DEPLOYMENT_CONFLICT`) before any request.
- A saved login is only sent to its own server. An eval run that would send it elsewhere throws `LOGIN_DEPLOYMENT_MISMATCH` before any request; a login saved before logins recorded their server counts as an MCPJam Cloud login, and one whose recorded server is not a usable address throws `LOGIN_DEPLOYMENT_MISMATCH` rather than going to MCPJam Cloud.
- Requests to MCPJam's ingest API never follow a redirect: a `3xx` answer throws `BACKEND_REDIRECT_REFUSED`.
- `reportEvalResultsSafely` and `reportConformanceRunSafely` rethrow these refusals instead of logging a warning.
- `reportConformanceRun` accepts `headers` for a deployment behind an edge authenticator.
