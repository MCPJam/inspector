import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gunzipSync } from "node:zlib";
import type { HarnessOwnerRef } from "../../harness-session-state";
import {
  saveSessionSnapshot,
  sessionSnapshotSaver,
  type SaveSessionSnapshotArgs,
} from "../save-session-snapshot";
import type { SnapshotFileSession } from "../snapshot-bundle";

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_URL = process.env.CONVEX_HTTP_URL;
const OWNER: HarnessOwnerRef = {
  projectId: "p1",
  harnessId: "claude-code",
  ownerType: "direct-chat",
  chatSessionId: "c1",
};
const TRANSCRIPT = "/home/user/.claude/projects/-home-user-w/abc.jsonl";

const box: SnapshotFileSession = {
  readTextFile: async () => '{"type":"user"}\n',
  writeTextFile: async () => undefined,
  run: async ({ command }) => ({
    exitCode: 0,
    stdout: command.startsWith("printf") ? "/home/user" : `16\t${TRANSCRIPT}\n`,
    stderr: "",
  }),
};

function args(
  overrides: Partial<SaveSessionSnapshotArgs> = {},
): SaveSessionSnapshotArgs {
  return {
    session: box,
    owner: OWNER,
    bearer: "token",
    harnessSessionId: "hs-1",
    stateVersion: 3,
    resumeState: { data: { claudeSessionId: "abc" } },
    secrets: [],
    ...overrides,
  };
}

type Call = { url: string; body: unknown; headers: Headers };

function mockBackend(uploadUrlAnswer: Record<string, unknown>) {
  const calls: Call[] = [];
  globalThis.fetch = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      const body =
        init?.body instanceof Uint8Array
          ? init.body
          : JSON.parse(String(init?.body));
      calls.push({ url, body, headers });
      if (url.endsWith("/snapshot/upload-url")) {
        return Response.json({ ok: true, ...uploadUrlAnswer });
      }
      if (url === "https://storage.example.com/upload") {
        return Response.json({ storageId: "kg2abc" });
      }
      if (url.endsWith("/snapshot/commit")) {
        return Response.json({ ok: true, saved: true });
      }
      return new Response("not found", { status: 404 });
    },
  ) as typeof fetch;
  return calls;
}

beforeEach(() => {
  process.env.CONVEX_HTTP_URL = "https://convex.example.com";
});
afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  process.env.CONVEX_HTTP_URL = ORIGINAL_URL;
  vi.restoreAllMocks();
});

describe("saveSessionSnapshot", () => {
  it("uploads the gzipped session files and commits them for the turn's version", async () => {
    const calls = mockBackend({
      enabled: true,
      uploadUrl: "https://storage.example.com/upload",
      key: "k1",
      contentType: "application/gzip;harness-session-snapshot=k1",
      maxBytes: 1_000_000,
    });

    expect(await saveSessionSnapshot(args())).toBe("saved");

    const [begin, upload, commit] = calls;
    expect(begin!.body).toMatchObject({
      ...OWNER,
      harnessSessionId: "hs-1",
      stateVersion: 3,
    });
    expect(upload!.headers.get("content-type")).toBe(
      "application/gzip;harness-session-snapshot=k1",
    );
    const bundle = JSON.parse(
      gunzipSync(upload!.body as Uint8Array).toString("utf8"),
    );
    expect(bundle.files).toEqual([
      {
        path: ".claude/projects/-home-user-w/abc.jsonl",
        content: '{"type":"user"}\n',
      },
    ]);
    expect(commit!.body).toMatchObject({
      ...OWNER,
      key: "k1",
      storageId: "kg2abc",
    });
  });

  it("reads nothing off the box when the backend says snapshots are off", async () => {
    const calls = mockBackend({ enabled: false, reason: "disabled" });
    const run = vi.spyOn(box, "run");
    expect(await saveSessionSnapshot(args())).toBe("refused");
    expect(run).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
  });

  it("does not upload a bundle larger than the backend accepts", async () => {
    const calls = mockBackend({
      enabled: true,
      uploadUrl: "https://storage.example.com/upload",
      key: "k1",
      contentType: "application/gzip;harness-session-snapshot=k1",
      maxBytes: 10,
    });
    expect(await saveSessionSnapshot(args())).toBe("too-large");
    expect(calls.map((call) => call.url)).toEqual([
      "https://convex.example.com/web/harness/session-state/snapshot/upload-url",
    ]);
  });
});

describe("sessionSnapshotSaver", () => {
  const base = {
    hosted: true,
    session: box,
    owner: OWNER,
    harnessSessionId: "hs-1",
    stateVersion: 3,
    resumeState: {},
    secrets: [],
    getBearer: async () => "token",
  };

  it("saves a hosted member turn whose secrets are known", () => {
    expect(sessionSnapshotSaver(base)).toBeTypeOf("function");
  });

  it("never saves a local turn, a guest lane or a turn with unknown secrets", () => {
    expect(sessionSnapshotSaver({ ...base, hosted: false })).toBeUndefined();
    expect(
      sessionSnapshotSaver({ ...base, secrets: undefined }),
    ).toBeUndefined();
    expect(
      sessionSnapshotSaver({ ...base, session: undefined }),
    ).toBeUndefined();
    expect(
      sessionSnapshotSaver({
        ...base,
        owner: { ...OWNER, executionScope: { kind: "swarm" } as never },
      }),
    ).toBeUndefined();
  });
});
