---
"@mcpjam/sdk": minor
---

A Claude readiness run against a server it cannot use now keeps every result that needs no server. `gatherClaudeReadinessEvidence` records `serverFailure` (`unreachable` when nothing at the connector URL answered, `connection` when the server refused the MCP session), and `gradeClaudeReadiness` gives each check that needed the server the reason "blocked: …" with the failure, instead of grading an unanswered request as the server's defect. An unreachable server no longer makes a run `not-ready`, its summary names the failure, and model observations about a server the run never read are not published. `placeDirectoryResults` shows a finding whose reason starts with "blocked: " as blocked.

Three new Claude checks: `claude.submission.access-matches-annotations` compares the Use cases read/write answer with the tools' `readOnlyHint` annotations; `claude.submission.declarations-confirmed` lists declarations still at the portal's default, imported, reset or unanswered (MCPJam's own check, not the portal's); and `claude.scan.cross-tool-direction-candidates` proposes sentences in tool and parameter descriptions that tell Claude to call another tool, as a heuristic that never fails a lane. `unconfirmedDeclarations(flow, answers)` is exported from `@mcpjam/sdk` and `@mcpjam/sdk/browser`.
