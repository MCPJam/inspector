---
"@mcpjam/sdk": minor
"@mcpjam/cli": minor
---

Provision a project and its servers without a browser.

Until now every eval, host and environment operation took a `projectId` and referenced servers by name — but nothing outside the web app could create either one. A CI pipeline could run evals against a project it had no way to set up, so the first step of any automation was still a human clicking through the UI. That gap is closed:

- **Project lifecycle** — `create_project`, `update_project`, `delete_project`, and `get_me` / `list_models` for identity and catalog reads. CLI: `mcpjam projects create | update | delete`.
- **Project servers** — `create_project_server`, `get_project_server`, `update_project_server`, `delete_project_server`, covering both secretless servers and ones carrying `env`, `headers` or an OAuth client secret (encrypted at rest, never returned by a read). CLI: `mcpjam projects server add | get | update | remove`.
- **Host wiring** — `set_host_servers` re-points a host's attached servers without round-tripping its whole config, and `duplicate_host` copies one. CLI: `mcpjam hosts servers | duplicate`.
- **Server diagnostics** — `validate_server` and `export_server` finally have operation wrappers; the client methods existed but no surface could reach them.

Permissions are the product's existing ladder, unchanged: creating a project needs organization membership and counts against the plan's project limit; server writes need project membership; host and environment writes need project admin. An `sk_…` key acts as the user it is bound to, so a non-admin's key gets the same answer the UI would give them.

Two notes for scripts. Server names are unique per workspace, so a create that clashes responds `409` rather than quietly returning the existing row — "apply" semantics stay explicit. And a project id from outside the caller's access reads as `404`, never `403`, so a response never confirms that a project exists.
