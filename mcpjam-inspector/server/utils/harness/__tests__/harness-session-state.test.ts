import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  claimHarnessSessionState,
  commitHarnessSessionState,
  heartbeatHarnessSessionState,
  type HarnessOwnerRef,
} from "../harness-session-state";

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_URL = process.env.CONVEX_HTTP_URL;
const OWNER: HarnessOwnerRef = {
  projectId: "p1",
  ownerType: "direct-chat",
  chatSessionId: "c1",
};

beforeEach(() => {
  process.env.CONVEX_HTTP_URL = "https://convex.example.com";
});
afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  process.env.CONVEX_HTTP_URL = ORIGINAL_URL;
  vi.restoreAllMocks();
});

function mockFetch(impl: (url: string, init: RequestInit) => Response) {
  globalThis.fetch = vi.fn(async (url: any, init: any) =>
    impl(String(url), init as RequestInit)
  ) as unknown as typeof fetch;
}

describe("claimHarnessSessionState", () => {
  it("POSTs the owner + lease and parses the resumable state", async () => {
    let seenUrl = "";
    let body: any;
    mockFetch((url, init) => {
      seenUrl = url;
      body = JSON.parse(String(init.body));
      return Response.json({
        ok: true,
        state: { harnessSessionId: "h1", resumeState: { a: 1 }, computerId: "comp" },
        stateVersion: 3,
        fingerprintChanged: false,
      });
    });
    const res = await claimHarnessSessionState({
      owner: OWNER,
      runtimeFingerprint: "fp",
      leaseId: "lease-1",
      leasedBy: "inst",
      leaseTtlMs: 300000,
      bearer: "tok",
    });
    expect(seenUrl).toBe(
      "https://convex.example.com/web/harness/session-state/claim"
    );
    expect(body).toMatchObject({
      projectId: "p1",
      ownerType: "direct-chat",
      chatSessionId: "c1",
      leaseId: "lease-1",
      runtimeFingerprint: "fp",
    });
    expect(res).toEqual({
      ok: true,
      state: { harnessSessionId: "h1", resumeState: { a: 1 }, computerId: "comp" },
      stateVersion: 3,
      fingerprintChanged: false,
    });
  });

  it("surfaces a 409 (turn in progress) as ok:false with status", async () => {
    mockFetch(
      () =>
        new Response(
          JSON.stringify({ ok: false, error: "A turn is already running for this chat." }),
          { status: 409 }
        )
    );
    const res = await claimHarnessSessionState({
      owner: OWNER,
      runtimeFingerprint: "fp",
      leaseId: "l",
      leasedBy: "i",
      leaseTtlMs: 300000,
      bearer: "t",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(409);
  });
});

describe("heartbeatHarnessSessionState — tri-state liveness", () => {
  const args = { owner: OWNER, leaseId: "l", leaseTtlMs: 300000, bearer: "t" };

  it("'ok' when the backend extends the lease", async () => {
    mockFetch(() => Response.json({ ok: true, extended: true }));
    expect(await heartbeatHarnessSessionState(args)).toBe("ok");
  });

  it("'lost' when the backend definitively reports the lease gone (extended:false)", async () => {
    mockFetch(() => Response.json({ ok: true, extended: false }));
    expect(await heartbeatHarnessSessionState(args)).toBe("lost");
  });

  it("'lost' on a definitive 4xx", async () => {
    mockFetch(
      () =>
        new Response(JSON.stringify({ ok: false, error: "nope" }), {
          status: 403,
        })
    );
    expect(await heartbeatHarnessSessionState(args)).toBe("lost");
  });

  it("'retryable' on a transient 5xx (don't abort on a blip)", async () => {
    mockFetch(
      () =>
        new Response(JSON.stringify({ ok: false, error: "boom" }), {
          status: 500,
        })
    );
    expect(await heartbeatHarnessSessionState(args)).toBe("retryable");
  });

  it("'retryable' on a network failure", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    expect(await heartbeatHarnessSessionState(args)).toBe("retryable");
  });
});

describe("commitHarnessSessionState", () => {
  it("returns false (non-fatal) when the commit endpoint rejects", async () => {
    mockFetch(
      () =>
        new Response(
          JSON.stringify({ ok: false, error: "harness_commit_version_conflict" }),
          { status: 409 }
        )
    );
    const ok = await commitHarnessSessionState({
      owner: OWNER,
      leaseId: "l",
      expectedStateVersion: 0,
      harnessSessionId: "h1",
      resumeState: {},
      computerId: "comp",
      runtimeFingerprint: "fp",
      bearer: "t",
    });
    expect(ok).toBe(false);
  });
});
