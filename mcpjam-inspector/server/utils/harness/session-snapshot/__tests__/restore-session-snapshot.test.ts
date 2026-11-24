import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  HarnessOwnerRef,
  HarnessResumePayload,
} from "../../harness-session-state";
import { HARNESS_IDS } from "@mcpjam/sdk/host-config/internal";
import { HARNESS_CONVERSATION_STATE } from "../../conversation-state";
import { startSessionSnapshotRestore } from "../restore-session-snapshot";
import { encodeSnapshot, type SnapshotFileSession } from "../snapshot-bundle";
import { sessionFileSpec } from "../session-files";

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_URL = process.env.CONVEX_HTTP_URL;
const OWNER: HarnessOwnerRef = {
  projectId: "p1",
  harnessId: "claude-code",
  ownerType: "direct-chat",
  chatSessionId: "c1",
};
const WORKDIR = "/home/user/claude-code-hs-1";
const TRANSCRIPT = ".claude/projects/-home-user-claude-code-hs-1/abc.jsonl";
/** Committed on box `sbx-old`; this turn runs on another box. */
const STATE: HarnessResumePayload = {
  harnessSessionId: "hs-1",
  computerId: "row-old",
  resumeState: {
    type: "resume-session",
    harnessId: "claude-code",
    data: { claudeSessionId: "abc", bridge: { sandboxId: "sbx-old" } },
  },
};

function snapshotBytes(overrides: Record<string, unknown> = {}) {
  return encodeSnapshot({
    version: 1,
    harnessId: "claude-code",
    harnessSessionId: "hs-1",
    workDir: WORKDIR,
    files: [{ path: TRANSCRIPT, content: '{"type":"user"}\n' }],
    ...overrides,
  });
}

function mockBackend(snapshot: Uint8Array<ArrayBuffer> | null) {
  const urls: string[] = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    if (url.endsWith("/snapshot/read") && snapshot) {
      return new Response(snapshot, {
        headers: { "content-type": "application/gzip" },
      });
    }
    if (url.endsWith("/snapshot/read")) {
      return new Response(null, { status: 204 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return urls;
}

function newBox() {
  const writes: Array<{ path: string; content: string }> = [];
  const session: SnapshotFileSession = {
    readTextFile: async () => null,
    writeTextFile: async (args) => {
      writes.push(args);
    },
    run: async ({ command }) => ({
      exitCode: 0,
      stdout: command.startsWith("printf") ? "/home/user" : "",
      stderr: "",
    }),
  };
  return { session, writes };
}

const start = (
  overrides: Partial<Parameters<typeof startSessionSnapshotRestore>[0]> = {},
) =>
  startSessionSnapshotRestore({
    hosted: true,
    owner: OWNER,
    state: STATE,
    stateVersion: 4,
    computerId: "row-new",
    sandboxId: "sbx-new",
    getBearer: async () => "token",
    ...overrides,
  });

beforeEach(() => {
  process.env.CONVEX_HTTP_URL = "https://convex.example.com";
});
afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_URL === undefined) delete process.env.CONVEX_HTTP_URL;
  else process.env.CONVEX_HTTP_URL = ORIGINAL_URL;
  vi.restoreAllMocks();
});

describe("startSessionSnapshotRestore", () => {
  it("downloads the saved session for a replaced box and writes it before the CLI starts", async () => {
    mockBackend(await snapshotBytes());
    const restore = start();
    expect(await restore!.ready()).toBe(true);
    const box = newBox();
    await restore!.apply(box.session, WORKDIR);
    expect(box.writes).toEqual([
      { path: `/home/user/${TRANSCRIPT}`, content: '{"type":"user"}\n' },
    ]);
  });

  it("lets a cancelled turn interrupt the writes, but not the download's timeout", async () => {
    mockBackend(await snapshotBytes());
    const cancel = new AbortController();
    const restore = start({ abortSignal: cancel.signal });
    await restore!.ready();
    const box = newBox();
    const signals: Array<AbortSignal | undefined> = [];
    const run = box.session.run;
    box.session.run = (args) => {
      signals.push(args.abortSignal);
      return run(args);
    };
    await restore!.apply(box.session, WORKDIR);
    expect(signals).toEqual([cancel.signal, cancel.signal]);
  });

  it("writes only once, even if the session is created again after a failure", async () => {
    mockBackend(await snapshotBytes());
    const restore = start();
    await restore!.ready();
    const box = newBox();
    await restore!.apply(box.session, WORKDIR);
    await restore!.apply(box.session, WORKDIR);
    expect(box.writes).toHaveLength(1);
  });

  it("asks for nothing when the box survived", async () => {
    const urls = mockBackend(await snapshotBytes());
    expect(
      start({ computerId: "row-old", sandboxId: "sbx-old" }),
    ).toBeUndefined();
    expect(urls).toEqual([]);
  });

  it("asks for nothing on local turns, guest lanes, other runtimes or paused approvals", async () => {
    mockBackend(await snapshotBytes());
    expect(start({ hosted: false })).toBeUndefined();
    expect(
      start({
        owner: { ...OWNER, executionScope: { kind: "swarm" } as never },
      }),
    ).toBeUndefined();
    expect(start({ owner: { ...OWNER, harnessId: "cursor" } })).toBeUndefined();
    expect(
      start({ state: { ...STATE, awaitingApproval: true } }),
    ).toBeUndefined();
    expect(start({ state: null })).toBeUndefined();
  });

  it("stops waiting as soon as the turn is cancelled", async () => {
    globalThis.fetch = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          if (init?.signal?.aborted) reject(init.signal.reason);
          init?.signal?.addEventListener("abort", () =>
            reject(init.signal!.reason),
          );
        }),
    ) as typeof fetch;
    const cancel = new AbortController();
    const restore = start({ abortSignal: cancel.signal });
    const ready = restore!.ready();
    cancel.abort(new Error("stopped"));
    expect(await ready).toBe(false);
  });

  it("reports nothing to restore when the backend has no matching snapshot", async () => {
    mockBackend(null);
    expect(await start()!.ready()).toBe(false);
  });

  it("refuses a snapshot saved under another working folder", async () => {
    mockBackend(
      await snapshotBytes({ workDir: "/home/user/elsewhere/claude-code-hs-1" }),
    );
    const restore = start();
    await restore!.ready();
    const box = newBox();
    await expect(restore!.apply(box.session, WORKDIR)).rejects.toThrow(
      /another working folder/,
    );
    expect(box.writes).toEqual([]);
  });
});

describe.each(
  HARNESS_IDS.filter((id) => HARNESS_CONVERSATION_STATE[id] !== null),
)("a replaced box running %s", (harnessId) => {
  const declaration = HARNESS_CONVERSATION_STATE[harnessId]!;
  const committed: HarnessResumePayload = {
    harnessSessionId: "hs-1",
    computerId: "row-old",
    resumeState: {
      type: "resume-session",
      harnessId,
      data: {
        ...(declaration.idKey ? { [declaration.idKey]: "cli-1" } : {}),
        bridge: { sandboxId: "sbx-old" },
      },
    },
  };
  const root = sessionFileSpec({
    harnessId,
    conversationState: declaration,
    harnessSessionId: "hs-1",
    resumeState: committed.resumeState,
    home: "/home/user",
  })!.root;
  const conversation = `${root.slice("/home/user/".length)}/a/conversation.jsonl`;
  const bytes = () =>
    encodeSnapshot({
      version: 1,
      harnessId,
      harnessSessionId: "hs-1",
      workDir: WORKDIR,
      files: [{ path: conversation, content: '{"turn":1}\n' }],
    });
  const restore = (state: HarnessResumePayload) =>
    start({ owner: { ...OWNER, harnessId }, state });

  it("puts the conversation's files back before the CLI starts", async () => {
    mockBackend(await bytes());
    const restored = restore(committed);
    expect(await restored!.ready()).toBe(true);
    const box = newBox();
    await restored!.apply(box.session, WORKDIR);
    expect(box.writes).toEqual([
      { path: `/home/user/${conversation}`, content: '{"turn":1}\n' },
    ]);
  });

  it("fetches nothing for a turn paused on an approval, so the paused action never becomes runnable", async () => {
    const urls = mockBackend(await bytes());
    expect(restore({ ...committed, awaitingApproval: true })).toBeUndefined();
    expect(urls).toEqual([]);
  });

  it("refuses another runtime's snapshot", async () => {
    mockBackend(
      await encodeSnapshot({
        version: 1,
        harnessId: harnessId === "claude-code" ? "codex" : "claude-code",
        harnessSessionId: "hs-1",
        workDir: WORKDIR,
        files: [{ path: conversation, content: "{}\n" }],
      }),
    );
    const restored = restore(committed);
    await restored!.ready();
    const box = newBox();
    await expect(restored!.apply(box.session, WORKDIR)).rejects.toThrow(
      /does not belong/,
    );
    expect(box.writes).toEqual([]);
  });
});
