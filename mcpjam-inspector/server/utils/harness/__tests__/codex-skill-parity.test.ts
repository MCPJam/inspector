/**
 * Codex SKILL parity — the gate for `codexAdapter.supportsSkills` (INS-8).
 *
 * The repo rule is that advertising a capability means enforcing it, so the flag
 * may only be on if the REAL adapter actually delivers. These tests therefore
 * drive the installed `@ai-sdk/harness-codex` `doStart` against a fake sandbox
 * session (no mock of the adapter, no reimplementation of its writer) and assert
 * what it puts on the box, then assert the SAME payload through the installed
 * `@ai-sdk/harness-claude-code` adapter to show the two runtimes are at parity
 * apart from their root.
 *
 * They pin the three facts MCPJam's own skill passes depend on:
 *   1. WHERE the skills land — `skillsBaseDir` must equal the adapter's real
 *      target, or the supporting-file / frontmatter / reconcile passes would
 *      operate on directories the runtime never reads.
 *   2. That the delivered SKILL.md is valid frontmatter for our descriptions
 *      (both runtimes interpolate `description: ${value}` raw, hence
 *      `frontmatterSafeSkills`).
 *   3. That a name MCPJam accepts is a name Codex accepts — its validator
 *      THROWS inside `doStart`, which would fail the whole turn.
 *
 * `doStart` is stopped at `spawn` (the point a real CLI process would start):
 * everything under test happens before it.
 */
import { describe, expect, it } from "vitest";
import matter from "gray-matter";
import { createCodex } from "@ai-sdk/harness-codex";
import { createClaudeCode } from "@ai-sdk/harness-claude-code";
import { getHarnessAdapter } from "../registry";
import {
  prepareCodexSkills,
  toHarnessSkills,
  type RuntimeSkill,
} from "../runtime-skills";

/** `$HOME` on the E2B harness box (see `e2b-sandbox-provider`). */
const BOX_HOME = "/home/user";
/** Sentinel thrown to end `doStart` at the process boundary. */
const STOP_AT_SPAWN = "stop-at-spawn";

type Write = { path: string; content: string };

/**
 * Minimal fake of the sandbox session the harness drives. Only the surface
 * `doStart` touches before spawning is implemented; `spawn` throws so no real
 * process (or bridge socket) is ever created.
 */
function fakeSandboxSession() {
  const writes: Write[] = [];
  const commands: string[] = [];
  const restricted = {
    run: async ({ command }: { command: string }) => {
      commands.push(command);
      // The adapters resolve the box's real $HOME before choosing a skills root.
      if (command.includes("$HOME")) {
        return { exitCode: 0, stdout: BOX_HOME, stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    readTextFile: async () => null,
    writeTextFile: async (write: Write) => {
      writes.push(write);
    },
    spawn: async () => {
      throw new Error(STOP_AT_SPAWN);
    },
  };
  return {
    writes,
    commands,
    session: {
      id: "sandbox-1",
      defaultWorkingDirectory: `${BOX_HOME}/work`,
      ports: [8080],
      restricted: () => restricted,
      getPortUrl: async () => "ws://localhost:8080",
    },
  };
}

/** Run the adapter's real `doStart` up to the spawn boundary. */
async function startWithSkills(
  harness: { doStart: (opts: unknown) => Promise<unknown> },
  skills: Array<{
    name: string;
    description: string;
    content: string;
    files?: Array<{ path: string; content: string }>;
  }>
): Promise<{ writes: Write[]; commands: string[]; error: unknown }> {
  const box = fakeSandboxSession();
  let error: unknown;
  try {
    await harness.doStart({
      sessionId: "session-1",
      sessionWorkDir: `${BOX_HOME}/work`,
      sandboxSession: box.session,
      permissionMode: "allow-all",
      skills,
    });
  } catch (err) {
    error = err;
  }
  return { writes: box.writes, commands: box.commands, error };
}

/** Writes under a skills root, in order (the adapter also writes bridge state). */
function skillWrites(writes: Write[], skillsBaseDir: string): Write[] {
  return writes.filter((w) => w.path.startsWith(`${skillsBaseDir}/`));
}

/** A write is "expected to have happened" only if we got past it to `spawn`. */
function expectReachedSpawn(error: unknown): void {
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toBe(STOP_AT_SPAWN);
}

function skill(p: Partial<RuntimeSkill> & { skillId: string }): RuntimeSkill {
  return {
    name: "pdf-tools",
    description: "Process PDFs",
    content: "# Body",
    aggregateHash: "h1",
    ...p,
  };
}

describe("codex skill parity (real @ai-sdk/harness-codex adapter)", () => {
  it("writes each delivered skill under the adapter's advertised skillsBaseDir", async () => {
    const adapter = getHarnessAdapter("codex");
    const prepared = prepareCodexSkills([
      skill({ skillId: "s1", name: "pdf-tools" }),
      skill({ skillId: "s2", name: "csv-tools", description: "Read CSVs" }),
    ]);

    const { writes, error } = await startWithSkills(
      createCodex() as never,
      prepared.payload
    );

    expectReachedSpawn(error);
    // The load-bearing assertion: the registry's root IS where codex writes.
    // If the adapter ever moves its root, every MCPJam skill pass would silently
    // target a directory the CLI does not read — this fails first.
    expect(adapter.skillsBaseDir).toBe(`${BOX_HOME}/.agents/skills`);
    expect(
      skillWrites(writes, adapter.skillsBaseDir).map((w) => w.path)
    ).toEqual([
      `${adapter.skillsBaseDir}/pdf-tools/SKILL.md`,
      `${adapter.skillsBaseDir}/csv-tools/SKILL.md`,
    ]);
    // Nothing lands anywhere else under $HOME's skill roots — in particular not
    // Claude Code's, which MCPJam's passes would then also have to reconcile.
    expect(writes.filter((w) => w.path.includes("/.claude/skills/"))).toEqual(
      []
    );
  });

  it("writes a skill's supporting files beside its SKILL.md", async () => {
    // MCPJam materializes supporting files itself (Convex blobs, byte budget),
    // but it must write them into the SAME dir layout the adapter uses.
    const adapter = getHarnessAdapter("codex");
    const { writes, error } = await startWithSkills(createCodex() as never, [
      {
        name: "pdf-tools",
        description: "Process PDFs",
        content: "# Body",
        files: [{ path: "scripts/run.py", content: "print(1)" }],
      },
    ]);

    expectReachedSpawn(error);
    expect(
      skillWrites(writes, adapter.skillsBaseDir).map((w) => w.path)
    ).toEqual([
      `${adapter.skillsBaseDir}/pdf-tools/SKILL.md`,
      `${adapter.skillsBaseDir}/pdf-tools/scripts/run.py`,
    ]);
  });

  it("produces PARSEABLE frontmatter for MCPJam-encoded descriptions", async () => {
    // codex builds `description: ${value}` by string interpolation, so a raw
    // description containing a quote or colon would emit broken YAML. This is
    // why the payload goes through `frontmatterSafeSkills` — assert on the file
    // the adapter actually wrote, not on our own encoder.
    const runtime = [
      skill({ skillId: "s1", description: 'Process: PDFs "safely"' }),
    ];
    const { writes, error } = await startWithSkills(
      createCodex() as never,
      prepareCodexSkills(runtime).payload
    );

    expectReachedSpawn(error);
    const parsed = matter(
      skillWrites(writes, getHarnessAdapter("codex").skillsBaseDir)[0]!.content
    );
    expect(parsed.data.name).toBe("pdf-tools");
    expect(parsed.data.description).toBe('Process: PDFs "safely"');
    expect(parsed.content.trim()).toBe("# Body");
  });

  it("would emit BROKEN frontmatter without the encoding (control)", async () => {
    // The negative half of the previous test: the semantic payload — what a
    // structurally-composing adapter could take — yields YAML that does not
    // round-trip through codex's raw interpolation.
    const { writes, error } = await startWithSkills(
      createCodex() as never,
      toHarnessSkills([
        skill({ skillId: "s1", description: 'Process: PDFs "safely"' }),
      ])
    );

    expectReachedSpawn(error);
    const written = skillWrites(
      writes,
      getHarnessAdapter("codex").skillsBaseDir
    )[0]!;
    let parsedDescription: unknown;
    try {
      parsedDescription = matter(written.content).data.description;
    } catch {
      parsedDescription = undefined; // YAML refused it outright
    }
    expect(parsedDescription).not.toBe('Process: PDFs "safely"');
  });

  it("accepts every name MCPJam's validator accepts", async () => {
    // `prepareCodexSkills` filters on MCPJam's `isValidSkillName`; that is only
    // safe if it is a SUBSET of codex's own rule. Names at the edges of the
    // shared spec (digits, hyphens, length) must all survive `doStart`.
    const names = [
      "a",
      "pdf-tools",
      "skill-2",
      "x9",
      "a-b-c-d",
      "z".repeat(64),
    ];
    const prepared = prepareCodexSkills(
      names.map((name, i) => skill({ skillId: `s${i}`, name }))
    );
    expect(prepared.skipped).toEqual([]);

    const { writes, error } = await startWithSkills(
      createCodex() as never,
      prepared.payload
    );

    expectReachedSpawn(error);
    expect(
      skillWrites(writes, getHarnessAdapter("codex").skillsBaseDir)
    ).toHaveLength(names.length);
  });

  it("THROWS on a name MCPJam filters out — which is why it filters", async () => {
    // Demonstrates the failure mode `prepareCodexSkills` exists to prevent: the
    // rejection happens inside `doStart`, so an unfiltered bad name takes down
    // the entire turn (not just that skill).
    const { error } = await startWithSkills(createCodex() as never, [
      { name: "..", description: "d", content: "c" },
    ]);
    expect((error as Error).message).toMatch(/Invalid Codex skill name/);
  });

  it("parity with Claude Code: same payload, same SKILL.md, own root", async () => {
    // Both runtimes are driven from one prepared payload, so a skill delivered
    // to Codex is the same skill the user sees on Claude Code — only the root
    // differs, and each adapter's root is the one the registry advertises.
    const codexAdapter = getHarnessAdapter("codex");
    const claudeAdapter = getHarnessAdapter("claude-code");
    const payload = prepareCodexSkills([
      skill({ skillId: "s1", description: 'Process: PDFs "safely"' }),
    ]).payload;

    const codexRun = await startWithSkills(createCodex() as never, payload);
    const claudeRun = await startWithSkills(
      createClaudeCode() as never,
      payload
    );

    expectReachedSpawn(codexRun.error);
    expectReachedSpawn(claudeRun.error);
    const codexWrite = codexRun.writes.find((w) =>
      w.path.endsWith("/SKILL.md")
    )!;
    const claudeWrite = claudeRun.writes.find((w) =>
      w.path.endsWith("/SKILL.md")
    )!;
    expect(codexWrite.path).toBe(
      `${codexAdapter.skillsBaseDir}/pdf-tools/SKILL.md`
    );
    expect(claudeWrite.path).toBe(
      `${claudeAdapter.skillsBaseDir}/pdf-tools/SKILL.md`
    );
    expect(claudeAdapter.skillsBaseDir).toBe(`${BOX_HOME}/.claude/skills`);
    // Same frontmatter + body (claude-code appends a trailing newline).
    const codexParsed = matter(codexWrite.content);
    const claudeParsed = matter(claudeWrite.content);
    expect(codexParsed.data).toEqual(claudeParsed.data);
    expect(codexParsed.content.trim()).toBe(claudeParsed.content.trim());
  });
});
