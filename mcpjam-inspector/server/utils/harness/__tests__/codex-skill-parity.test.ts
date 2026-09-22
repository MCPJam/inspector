/**
 * Codex SKILL parity — the gate for `codexAdapter.supportsSkills` (INS-8).
 *
 * The repo rule is that advertising a capability means enforcing it, so the flag
 * may only be on if the REAL adapter actually delivers. These tests therefore
 * drive the installed `@ai-sdk/harness-codex` adapter against a fake sandbox
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
 *   3. That a name MCPJam accepts is a name the adapters accept — the shared
 *      writer's validator THROWS mid-turn, which would fail the whole turn.
 *
 * HOW THE DRIVE WORKS on the `1.0.x` stable line. The canary adapters wrote
 * skills during `doStart` (so the old version of this file stopped `doStart`
 * at `spawn`); stable writes them at PROMPT time, inside `doPromptTurn`,
 * re-synced every turn. Reaching `doPromptTurn` requires a live session, so
 * each test runs a minimal fake bridge: a real WebSocket server standing in
 * for the in-sandbox bridge process, a `bridge-meta.json` read that reports it
 * ready, and a spawn that returns an inert process handle. The skill writes
 * land BEFORE the adapter sends its start message, so the fake bridge never
 * has to answer anything (beyond claude-code's `bridge-hello` greeting).
 */
import { describe, expect, it } from "vitest";
import matter from "gray-matter";
import { WebSocketServer } from "ws";
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

type Write = { path: string; content: string };

type HarnessSkillPayload = Array<{
  name: string;
  description: string;
  content: string;
  files?: Array<{ path: string; content: string }>;
}>;

/**
 * Minimal fake of the sandbox session the harness drives — the same surface
 * MCPJam's `e2b-sandbox-provider` exposes. `bridge-meta.json` always reads as
 * "waiting" so `waitForBridgeReady` resolves on its first metadata poll, and
 * `getPortEndpoint` points the adapter's bridge WebSocket at the test server.
 */
function fakeSandboxSession(bridgeType: "codex" | "claude-code", port: number) {
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
    readTextFile: async ({ path }: { path: string }) =>
      path.endsWith("/bridge-meta.json")
        ? JSON.stringify({ type: bridgeType, state: "waiting", port })
        : null,
    writeTextFile: async (write: Write) => {
      writes.push(write);
    },
    // An inert bridge process: the real bridge is the test's WebSocket server,
    // so the handle only has to satisfy stream readers and teardown.
    spawn: async () => ({
      stdout: new ReadableStream<Uint8Array>({ start() {} }),
      stderr: new ReadableStream<Uint8Array>({ start() {} }),
      kill: async () => {},
      wait: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    }),
  };
  return {
    writes,
    commands,
    session: {
      id: "sandbox-1",
      defaultWorkingDirectory: `${BOX_HOME}/work`,
      ports: [port],
      restricted: () => restricted,
      getPortEndpoint: async () => ({ url: `ws://127.0.0.1:${port}` }),
    },
  };
}

/**
 * Drive the adapter's real `doStart` to a live session, then its real
 * `doPromptTurn` — the point where the stable adapters write skills — and
 * capture everything written to the box. The turn itself is never answered;
 * skills land before the start message goes out.
 */
async function promptWithSkills(
  harness: {
    harnessId: string;
    doStart: (opts: unknown) => Promise<{
      doPromptTurn: (opts: unknown) => Promise<{ done: Promise<unknown> }>;
      doDestroy: () => Promise<unknown>;
    }>;
  },
  skills: HarnessSkillPayload
): Promise<{ writes: Write[]; commands: string[]; error: unknown }> {
  const bridgeType = harness.harnessId as "codex" | "claude-code";
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((resolve) => wss.once("listening", resolve));
  const port = (wss.address() as { port: number }).port;
  wss.on("connection", (socket) => {
    // claude-code's connect handshake waits for the bridge's greeting; codex
    // opens the socket and moves on.
    if (bridgeType === "claude-code") {
      socket.send(JSON.stringify({ type: "bridge-hello" }));
    }
  });

  const box = fakeSandboxSession(bridgeType, port);
  let session:
    | Awaited<ReturnType<(typeof harness)["doStart"]>>
    | undefined;
  let error: unknown;
  try {
    session = await harness.doStart({
      sessionId: "session-1",
      sessionWorkDir: `${BOX_HOME}/work`,
      sandboxSession: box.session,
      permissionMode: "allow-all",
    });
    const control = await session.doPromptTurn({
      prompt: "hello",
      tools: [],
      skills,
      emit: () => {},
    });
    // The fake bridge never finishes the turn; teardown rejects `done`.
    control.done.catch(() => {});
  } catch (err) {
    error = err;
  } finally {
    try {
      await session?.doDestroy();
    } catch {
      /* teardown only */
    }
    for (const client of wss.clients) client.terminate();
    await new Promise((resolve) => wss.close(() => resolve(undefined)));
  }
  return { writes: box.writes, commands: box.commands, error };
}

/** Skill-content writes under a skills root, excluding the shared writer's own
 *  `.ai-sdk-harness-skills.json` sync manifest (an adapter implementation
 *  detail, not a delivered skill). */
function skillWrites(writes: Write[], skillsBaseDir: string): Write[] {
  return writes.filter(
    (w) =>
      w.path.startsWith(`${skillsBaseDir}/`) &&
      !w.path.includes("/.ai-sdk-harness-skills.json")
  );
}

/** Writes are "expected to have happened" only if the whole turn setup ran. */
function expectReachedPrompt(error: unknown): void {
  expect(error).toBeUndefined();
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

    const { writes, error } = await promptWithSkills(
      createCodex() as never,
      prepared.payload
    );

    expectReachedPrompt(error);
    // The load-bearing assertion: the registry's root IS where codex writes.
    // If the adapter ever moves its root, every MCPJam skill pass would silently
    // target a directory the CLI does not read — this fails first.
    expect(adapter.skillsBaseDir).toBe(`${BOX_HOME}/.agents/skills`);
    // (The stable writer syncs skills sorted by name, so csv-tools lands first.)
    expect(
      skillWrites(writes, adapter.skillsBaseDir).map((w) => w.path)
    ).toEqual([
      `${adapter.skillsBaseDir}/csv-tools/SKILL.md`,
      `${adapter.skillsBaseDir}/pdf-tools/SKILL.md`,
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
    const { writes, error } = await promptWithSkills(createCodex() as never, [
      {
        name: "pdf-tools",
        description: "Process PDFs",
        content: "# Body",
        files: [{ path: "scripts/run.py", content: "print(1)" }],
      },
    ]);

    expectReachedPrompt(error);
    // Within a skill the writer orders files by locale, so compare as a set.
    expect(
      skillWrites(writes, adapter.skillsBaseDir)
        .map((w) => w.path)
        .sort()
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
    const { writes, error } = await promptWithSkills(
      createCodex() as never,
      prepareCodexSkills(runtime).payload
    );

    expectReachedPrompt(error);
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
    const { writes, error } = await promptWithSkills(
      createCodex() as never,
      toHarnessSkills([
        skill({ skillId: "s1", description: 'Process: PDFs "safely"' }),
      ])
    );

    expectReachedPrompt(error);
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

    const { writes, error } = await promptWithSkills(
      createCodex() as never,
      prepared.payload
    );

    expectReachedPrompt(error);
    expect(
      skillWrites(writes, getHarnessAdapter("codex").skillsBaseDir)
    ).toHaveLength(names.length);
  });

  it("THROWS on a name MCPJam filters out — which is why it filters", async () => {
    // Demonstrates the failure mode `prepareCodexSkills` exists to prevent: on
    // the stable line the rejection happens inside `doPromptTurn` (skills are
    // synced per turn), so an unfiltered bad name takes down the entire turn
    // (not just that skill).
    const { error } = await promptWithSkills(createCodex() as never, [
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

    const codexRun = await promptWithSkills(createCodex() as never, payload);
    const claudeRun = await promptWithSkills(
      createClaudeCode() as never,
      payload
    );

    expectReachedPrompt(codexRun.error);
    expectReachedPrompt(claudeRun.error);
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
