/**
 * On-box skill ROOTS, one per harness runtime.
 *
 * The harness adapter — not MCPJam — writes SKILL.md, and each runtime picks its
 * own root: Claude Code writes `$HOME/.claude/skills/<name>/`, Codex writes
 * `$HOME/.agents/skills/<name>/` (both verified against the installed packages'
 * `writeSkills`). MCPJam's own passes (stale-dir reconcile, supporting-file
 * materialization, extra-frontmatter rewrite, turn-end adoption) operate on the
 * SAME dirs the adapter wrote, so the root is a per-adapter fact: it travels
 * with the runtime via `HarnessRuntimeAdapter.skillsBaseDir` rather than being a
 * constant baked into each pass.
 *
 * `/home/user` is the E2B box's `$HOME` (see `e2b-sandbox-provider.ts`); the
 * adapters resolve `$HOME` at runtime and land on the same absolute path.
 */

/** Claude Code's skills root (`~/.claude/skills`). */
export const CLAUDE_CODE_SKILLS_BASE = "/home/user/.claude/skills";

/** Codex's skills root (`~/.agents/skills`, the Agent-Skills-spec location). */
export const CODEX_SKILLS_BASE = "/home/user/.agents/skills";
