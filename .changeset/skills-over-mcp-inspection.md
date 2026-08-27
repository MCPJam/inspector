---
"@mcpjam/sdk": minor
"@mcpjam/cli": minor
"@mcpjam/inspector": minor
---

Skills over MCP is inspectable from every agent surface, not just the Skills tab

MCPJam has sat on both sides of SEP-2640 for a while — the host consumes and verifies, the hosted worker and the CLI serve their own skills — but the only place anyone could *see* what a connected server serves was the Skills tab. `mcpjam --help` had no `skills` command, none of the hosted platform tools could list a server's skills even though `list_server_tools` / `list_server_resources` / `list_server_prompts` all existed, and the CLI's own MCP server exposed `list_resources` with no skills equivalent. Skills was the one primitive-shaped surface in MCPJam with no agent-reachable inspection path.

The closest a developer could get was `mcpjam resources list`, which shows `skill://` URIs as ordinary resources. That proves the wire and shows nothing that makes a skill a skill: no manifest, no digest or size verification, no identity check, and no refusal reasons.

**The refusals are the product.** A server author asking "why won't this skill load" needs to know *which* digest, *which* field, *which* URI — so every new surface answers with either verified content or a refusal naming the check that failed, as a result rather than an error. `mcpjam skills read` on an unlisted URI exits 0 with `unlisted_resource`; refusing to load an unverifiable skill is the tool working.

What ships:

- `mcpjam skills list | get | read` — connects directly, so it needs no project and no API key.
- `list_server_skills` / `get_server_skill` / `read_server_skill_file` on the platform catalog, which places them on the hosted MCP worker, `/api/v1`, and the in-app assistant at once.
- `POST /v1/projects/{p}/servers/{s}/skills{,/get,/read-file}`, documented in `openapi.json`.
- `list_skills` / `get_skill` / `read_skill_file` on `mcpjam mcp`, which already *served* skills and could not read them.
- A `skills` check in `server doctor` that verifies rather than counts — a listing looks identical whether or not the bytes behind it match their digests.

The verified read path itself moved into `@mcpjam/sdk`. Its docblock always claimed to be the one module between every MCPJam surface and a `skills/*` call, naming the CLI as a consumer; living in the inspector, that was aspiration, and any skills surface the CLI or worker grew would have had to re-decide which server behaviours are refusals. It is now importable, and the inspector keeps its old import path.

Two behaviours worth knowing:

`mcpjam skills list --host cursor` **refuses** rather than advertising the extension anyway. Pinning a host persona means "advertise exactly what that host advertises", so quietly adding skills would answer "what can MCPJam see" while you asked "what would Cursor see". The refusal is the honest answer: that host would see nothing.

The doctor's skills check samples at most 5 skills, because verification costs a `resources/read` each and a 200-skill server should not turn a doctor run into a bulk download. A manifest that disagrees with its bytes is almost never wrong for one skill alone.
