---
"@mcpjam/cli": minor
---

`mcpjam mcp --evals` adds MCPJam's eval tools and the `run-mcpjam-evals` skill to the local MCP server, so a coding agent can create, run and read evals over the same connection it uses to debug servers. The tools are the hosted MCP server's own, with the same names, inputs and safety hints, plus the read tools that find a project, server, model, client or environment. They use your MCPJam sign-in (`mcpjam cloud login`, or `MCPJAM_API_KEY` in the server's env in your MCP client's config) and run evals on the MCPJam server the CLI is signed in to. Without `--evals`, `mcpjam mcp` is unchanged.
