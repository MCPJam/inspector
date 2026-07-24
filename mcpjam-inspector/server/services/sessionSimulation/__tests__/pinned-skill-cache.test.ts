import { afterEach, describe, expect, it } from "vitest";
import {
  __clearPinnedSkillCacheForTest,
  __pinnedSkillCacheSizeForTest,
  isRetryablePinnedSkillError,
  resolvePinnedSkillCached,
} from "../pinned-skill-cache.js";
import {
  PinnedSkillIntegrityError,
  SwarmAgentError,
} from "../../swarm-agent.js";
import type { PinnedSkillArtifact } from "../../../../shared/skill-types.js";

const artifact = (contentHash: string): PinnedSkillArtifact => ({
  name: "s",
  description: "d",
  content: "body",
  contentHash,
});

afterEach(() => {
  __clearPinnedSkillCacheForTest();
});

describe("pinned-skill cache", () => {
  it("caches by (projectId, contentHash): second resolve hits without refetch", async () => {
    let calls = 0;
    const fetcher = async () => {
      calls++;
      return artifact("h1");
    };
    const a = await resolvePinnedSkillCached({
      projectId: "p1",
      contentHash: "h1",
      fetcher,
    });
    const b = await resolvePinnedSkillCached({
      projectId: "p1",
      contentHash: "h1",
      fetcher,
    });
    expect(a).toBe(b);
    expect(calls).toBe(1);
    expect(__pinnedSkillCacheSizeForTest()).toBe(1);
  });

  it("coalesces concurrent in-flight fetches (two targets, one fetch)", async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fetcher = async () => {
      calls++;
      await gate;
      return artifact("h1");
    };
    const p1 = resolvePinnedSkillCached({
      projectId: "p1",
      contentHash: "h1",
      fetcher,
    });
    const p2 = resolvePinnedSkillCached({
      projectId: "p1",
      contentHash: "h1",
      fetcher,
    });
    release();
    const [a, b] = await Promise.all([p1, p2]);
    expect(calls).toBe(1);
    expect(a).toBe(b);
  });

  it("NEVER caches failures: after a rejected fetch the next caller fetches fresh", async () => {
    let calls = 0;
    const failing = async () => {
      calls++;
      throw new SwarmAgentError(404, "", "not found");
    };
    await expect(
      resolvePinnedSkillCached({
        projectId: "p1",
        contentHash: "h1",
        fetcher: failing,
        retryDelaysMs: [0, 0],
      }),
    ).rejects.toThrow("not found");
    expect(__pinnedSkillCacheSizeForTest()).toBe(0);
    // Next caller retries fresh (and can succeed).
    const ok = await resolvePinnedSkillCached({
      projectId: "p1",
      contentHash: "h1",
      fetcher: async () => artifact("h1"),
    });
    expect(ok.contentHash).toBe("h1");
    // 404 is non-retryable: the failing fetcher ran exactly once.
    expect(calls).toBe(1);
  });

  it("retries transient failures twice, then succeeds", async () => {
    let calls = 0;
    const flaky = async () => {
      calls++;
      if (calls < 3) throw new SwarmAgentError(503, "", "unavailable");
      return artifact("h1");
    };
    const got = await resolvePinnedSkillCached({
      projectId: "p1",
      contentHash: "h1",
      fetcher: flaky,
      retryDelaysMs: [0, 0],
    });
    expect(got.contentHash).toBe("h1");
    expect(calls).toBe(3);
  });

  it("does NOT retry a hash-mismatch (integrity) error", async () => {
    let calls = 0;
    const bad = async () => {
      calls++;
      throw new PinnedSkillIntegrityError("hash mismatch");
    };
    await expect(
      resolvePinnedSkillCached({
        projectId: "p1",
        contentHash: "h1",
        fetcher: bad,
        retryDelaysMs: [0, 0],
      }),
    ).rejects.toThrow("hash mismatch");
    expect(calls).toBe(1);
  });

  it("keys by project too — same hash in two projects is two entries", async () => {
    let calls = 0;
    const fetcher = async () => {
      calls++;
      return artifact("h1");
    };
    await resolvePinnedSkillCached({ projectId: "p1", contentHash: "h1", fetcher });
    await resolvePinnedSkillCached({ projectId: "p2", contentHash: "h1", fetcher });
    expect(calls).toBe(2);
    expect(__pinnedSkillCacheSizeForTest()).toBe(2);
  });
});

describe("isRetryablePinnedSkillError", () => {
  it("classifies per the policy: 5xx/transport retry; 404/integrity/abort never", () => {
    expect(isRetryablePinnedSkillError(new SwarmAgentError(500, "", "x"))).toBe(true);
    expect(isRetryablePinnedSkillError(new TypeError("fetch failed"))).toBe(true);
    expect(isRetryablePinnedSkillError(new SwarmAgentError(404, "", "x"))).toBe(false);
    expect(
      isRetryablePinnedSkillError(new PinnedSkillIntegrityError("x")),
    ).toBe(false);
    const abort = new Error("aborted");
    abort.name = "AbortError";
    expect(isRetryablePinnedSkillError(abort)).toBe(false);
  });
});
