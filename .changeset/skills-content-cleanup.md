---
"@mcpjam/sdk": patch
"@mcpjam/inspector": patch
---

Clean the two SDK skills before we publish them over MCP

`explore-to-sdk-evals` never had valid frontmatter. Its opening fence was followed by `## name: playground-to-sdk-evals` — a markdown heading, not a YAML key — with no closing `---`, so the real parser returns two YAML errors and `frontmatter: undefined`. The declared name also disagreed with the directory. Both are fatal to `checkSkillIdentity`, and neither was caught because nothing ever parsed the file: it is consumed as raw text through `@mcpjam/sdk/skill-reference`. The fence is repaired and the skill is now named for its directory. The body carried the same damage — `` `**@mcpjam/sdk`** ``, `` `**package.json**` ``, `` `**jest.config.***` `` and about forty more interleaved emphasis/code markers, the residue of a rich-text paste — all corrected. Stale "Playground" naming is now "Explore", matching the surface it reads from.

`create-mcp-eval` was 1,031 lines in one file with no supporting files, which is the opposite of what a per-file manifest is for. It is now a routing `SKILL.md` — the reference map, context gathering, and generation guidelines — plus six references: `project-setup`, `sdk-api`, `patterns`, `template`, `common-mistakes`, `agent-brief`. Verified content-preserving: the heading set before and after is identical but for the added reference map.

The split would otherwise have broken the Inspector's "copy agent brief" button, which puts one markdown blob on the clipboard for a reader who has no `references/` directory to follow links into. `SKILL_MD` therefore stays whole, assembled in `skill-reference.ts` from the same files the skill ships — one source of truth, two deliveries. `CREATE_MCP_EVAL_SKILL_MD` exposes the routing file alone for consumers that can fetch references themselves.

All four repo-authored skills now pass our own `checkSkillIdentity` gate against a `skill://mcpjam/<name>/SKILL.md` URI. `explore-to-sdk-evals` did not before.
