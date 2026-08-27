import { afterEach, describe, expect, it, vi } from "vitest";
import { runPinnedSkillsToHarnessArtifacts } from "../run-pinned-harness-skills.js";
import { RunPluginSnapshotError } from "../run-plugin-snapshot.js";
import type { RunPinnedSkill } from "../run-plugin-snapshot.js";

/**
 * A run's frozen skills, adapted into the shape the harness materializes ON
 * BOX. What this file is really guarding is the difference between "the run
 * delivered its pinned surface" and "the run delivered something that looked
 * like it": a body without its scripts, a body-only hash that makes a changed
 * file set invisible to reconcile, or a binary silently mangled by a UTF-8
 * decode.
 */
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const pin = (over: Partial<RunPinnedSkill> = {}): RunPinnedSkill => ({
  name: "deploy",
  description: "ship it",
  content: "# Deploy\n",
  contentHash: "body-hash",
  ...over,
});

function stubFetch(
  responder: (
    url: string
  ) =>
    | { body: Uint8Array | string; contentType?: string; status?: number }
    | Error
) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const result = responder(String(url));
      if (result instanceof Error) throw result;
      const bytes =
        typeof result.body === "string"
          ? new TextEncoder().encode(result.body)
          : result.body;
      return {
        ok: (result.status ?? 200) < 400,
        status: result.status ?? 200,
        headers: {
          get: (k: string) =>
            k.toLowerCase() === "content-type"
              ? result.contentType ?? null
              : null,
        },
        arrayBuffer: async () =>
          bytes.buffer.slice(
            bytes.byteOffset,
            bytes.byteOffset + bytes.byteLength
          ),
      } as unknown as Response;
    })
  );
}

describe("runPinnedSkillsToHarnessArtifacts", () => {
  it("returns an empty list for an empty pin set — a real answer, not a fall-through", async () => {
    // The harness selects its pinned source by PRESENCE. `[]` says "this run
    // delivers no skills"; the caller's job is to pass it rather than nothing.
    expect(await runPinnedSkillsToHarnessArtifacts([])).toEqual([]);
  });

  it("carries pin identity through verbatim — nothing is synthesized", async () => {
    const [artifact] = await runPinnedSkillsToHarnessArtifacts([
      pin({
        skillId: "sk-1",
        sharing: "project",
        channels: ["host", "environment"],
        extraFrontmatter: { license: "MIT" },
      }),
    ]);

    expect(artifact).toEqual({
      name: "deploy",
      description: "ship it",
      content: "# Deploy\n",
      contentHash: "body-hash",
      skillId: "sk-1",
      sharing: "project",
      channels: ["host", "environment"],
      frontmatter: { license: "MIT" },
    });
  });

  it("prefers aggregateHash — a body-only hash would hide a changed file set", async () => {
    // The artifact's contentHash becomes the runtime `aggregateHash` that
    // drives on-box reconcile. If two snapshots of a skill whose FILES changed
    // carried the same body hash, reconcile would call the box current and keep
    // the previous run's scripts.
    stubFetch(() => ({ body: "echo hi", contentType: "text/x-shellscript" }));
    const [artifact] = await runPinnedSkillsToHarnessArtifacts([
      pin({
        contentHash: "body-hash",
        aggregateHash: "envelope-hash",
        files: [
          { path: "run.sh", contentHash: "f1", size: 7, url: "https://blob/1" },
        ],
      }),
    ]);
    expect(artifact!.contentHash).toBe("envelope-hash");
  });

  it("downloads supporting files inline, text as content", async () => {
    stubFetch(() => ({ body: "echo hi", contentType: "text/x-shellscript" }));
    const [artifact] = await runPinnedSkillsToHarnessArtifacts([
      pin({
        files: [
          { path: "run.sh", contentHash: "f1", size: 7, url: "https://blob/1" },
        ],
      }),
    ]);
    expect(artifact!.files).toEqual([
      { path: "run.sh", mimeType: "text/x-shellscript", content: "echo hi" },
    ]);
  });

  it("sends non-text (and unknown-type) files as base64, never a lossy decode", async () => {
    // The harness writer branches on which key is present: `content` goes
    // through writeTextFile, `base64` through `base64 -d`. Guessing "text" for
    // a binary corrupts the file on box, so an unknown content-type must fall
    // to base64 rather than the other way round.
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
    for (const contentType of ["image/png", undefined]) {
      stubFetch(() => ({
        body: bytes,
        ...(contentType ? { contentType } : {}),
      }));
      const [artifact] = await runPinnedSkillsToHarnessArtifacts([
        pin({
          files: [
            {
              path: "logo.png",
              contentHash: "f1",
              size: 6,
              url: "https://blob/1",
            },
          ],
        }),
      ]);
      expect(artifact!.files![0]!.base64).toBe(
        Buffer.from(bytes).toString("base64")
      );
      expect(artifact!.files![0]!.content).toBeUndefined();
    }
  });

  it("drops the mcp-server channel tag rather than widening the artifact union", async () => {
    const [artifact] = await runPinnedSkillsToHarnessArtifacts([
      pin({
        channels: ["host", "mcp-server"] as RunPinnedSkill["channels"],
      }),
    ]);
    expect(artifact!.channels).toEqual(["host"]);
  });

  it("FAILS the run when a supporting file cannot be downloaded", async () => {
    // A skill delivered without its scripts is the silent-degradation shape
    // this whole change exists to remove: the run would report the skill as
    // delivered and the judge would score a surface that was never there.
    stubFetch(() => ({ body: "", status: 404 }));
    await expect(
      runPinnedSkillsToHarnessArtifacts([
        pin({
          files: [
            {
              path: "run.sh",
              contentHash: "f1",
              size: 7,
              url: "https://blob/1",
            },
          ],
        }),
      ])
    ).rejects.toThrow(RunPluginSnapshotError);
  });

  it("FAILS the run when the download throws, naming the skill and path", async () => {
    stubFetch(() => new Error("connection reset"));
    await expect(
      runPinnedSkillsToHarnessArtifacts([
        pin({
          modelRef: "acme/deploy",
          files: [
            {
              path: "run.sh",
              contentHash: "f1",
              size: 7,
              url: "https://blob/1",
            },
          ],
        }),
      ])
    ).rejects.toThrow(/acme\/deploy[\s\S]*run\.sh/);
  });

  it("FAILS the run on a null blob URL rather than treating it as no file", async () => {
    await expect(
      runPinnedSkillsToHarnessArtifacts([
        pin({
          files: [{ path: "run.sh", contentHash: "f1", size: 7, url: null }],
        }),
      ])
    ).rejects.toThrow(RunPluginSnapshotError);
  });
});
