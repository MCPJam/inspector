---
"@mcpjam/cli": minor
---

Add `mcpjam test <file>`: run an MCPJam eval suite file locally. Bring your own provider key (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …) and no MCPJam account is needed; `--inference mcpjam` (or `auto` with no key) uses MCPJam-hosted inference through your existing login and billing. Results are never uploaded.

Target servers bind by name from `--server name=url`, `--mcp-config`, `./.mcp.json` or `./.mcpjam/mcp.json` (whole entries, `${VAR}` / `${VAR:-default}` expanded only in the entries used). `--case` reruns exact case ids, `--host` emulates a host template, the suite's `toolPolicy` is enforced before any tool call, and `--allow-approximated` / `--approval-reason` approve imported cases for the run. Reports come out as the human summary, JSON, `--reporter junit-xml|html|json-summary` or `--out <file>`, all marked local and emulated. Exit codes: `0` passed, `1` failed, `2` invalid input or an unsupported local capability, `3` credentials, `4` setup or billing, `5` inconclusive or interrupted.

The hosted `cloud eval run --file` refusal for a suite with `toolPolicy` now points at `mcpjam test <file>`, which enforces it.
