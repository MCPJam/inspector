/**
 * Materialized secret delivery: the tri-state, and the rotation fork.
 *
 * Both properties are the kind that only fail in production, so they are pinned
 * here rather than trusted to the shape of the code:
 *
 *   - a FETCH FAILURE must not be indistinguishable from "no secrets". If it
 *     were, a Convex blip would strip a working session's credentials and the
 *     user would see a `stripe` command start failing with nothing changed on
 *     their side.
 *   - a ROTATION must change the fingerprint. A resumed harness session
 *     reattaches to a bridge process holding the environment it was created
 *     with, so a rotation that did not fork would land everywhere except the
 *     conversation the user is sitting in.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const listSecrets = vi.fn();
vi.mock("../../computers/convex-secrets-client.js", () => ({
  convexListSecretsForRuntimeExecution: (...args: unknown[]) =>
    listSecrets(...args),
}));

const { fetchRuntimeSecrets, deliveredSecretsFingerprint, toSecretEnv } =
  await import("../runtime-secrets.js");

afterEach(() => {
  vi.clearAllMocks();
});

describe("fetchRuntimeSecrets", () => {
  it("returns an empty SUCCESS when there is no environment to grant from", async () => {
    // The environment IS the grant boundary. No environment is not a failure —
    // there is simply nothing granted — so callers must not treat it as one.
    await expect(
      fetchRuntimeSecrets("Bearer t", { projectId: "p1" }),
    ).resolves.toEqual({ ok: true, secrets: [] });
    expect(listSecrets).not.toHaveBeenCalled();
  });

  it("returns an empty SUCCESS with no bearer, without calling the backend", async () => {
    await expect(
      fetchRuntimeSecrets(undefined, { projectId: "p1", environmentId: "e1" }),
    ).resolves.toEqual({ ok: true, secrets: [] });
    expect(listSecrets).not.toHaveBeenCalled();
  });

  it("passes the bearer and the ids through, and returns what the backend gave", async () => {
    listSecrets.mockResolvedValueOnce([
      { name: "STRIPE_API_KEY", value: "sk" },
    ]);
    await expect(
      fetchRuntimeSecrets("Bearer t", {
        projectId: "p1",
        environmentId: "e1",
        chatSessionId: "cs1",
      }),
    ).resolves.toEqual({
      ok: true,
      secrets: [{ name: "STRIPE_API_KEY", value: "sk" }],
    });
    expect(listSecrets).toHaveBeenCalledWith("Bearer t", {
      projectId: "p1",
      environmentId: "e1",
      chatSessionId: "cs1",
    });
  });

  it("reports a failure as { ok: false }, NEVER as an empty list", async () => {
    listSecrets.mockRejectedValueOnce(new Error("convex down"));
    await expect(
      fetchRuntimeSecrets("Bearer t", {
        projectId: "p1",
        environmentId: "e1",
      }),
    ).resolves.toEqual({ ok: false });
  });
});

describe("deliveredSecretsFingerprint", () => {
  it("is empty for no secrets, so a secretless turn keeps resuming", () => {
    // Byte-identical to a world where this dimension does not exist.
    expect(deliveredSecretsFingerprint([])).toBe("");
  });

  it("changes when a secret ROTATES under the same name", () => {
    // Rotation is the event that must fork a resumable session, and the
    // backend's `updatedAt` is what marks it.
    const before = deliveredSecretsFingerprint([
      { name: "STRIPE_API_KEY", value: "sk_live_old", updatedAt: 1_000 },
    ]);
    const after = deliveredSecretsFingerprint([
      { name: "STRIPE_API_KEY", value: "sk_live_new", updatedAt: 2_000 },
    ]);
    expect(after).not.toBe(before);
  });

  it("IGNORES the value entirely — the same row hashes the same either way", () => {
    // The security property, stated as an assertion rather than a comment.
    // Hashing the credential (at any strength, unsalted) would put a scoring
    // oracle for a low-entropy secret into persisted session state, and folding
    // that digest into a second hash would not remove it.
    const withOne = deliveredSecretsFingerprint([
      { name: "PIN", value: "0000", updatedAt: 7 },
    ]);
    const withAnother = deliveredSecretsFingerprint([
      { name: "PIN", value: "9999", updatedAt: 7 },
    ]);
    expect(withAnother).toBe(withOne);
  });

  it("changes when a secret is added or removed", () => {
    const one = deliveredSecretsFingerprint([
      { name: "A_KEY", value: "v1", updatedAt: 1 },
    ]);
    const two = deliveredSecretsFingerprint([
      { name: "A_KEY", value: "v1", updatedAt: 1 },
      { name: "B_KEY", value: "v2", updatedAt: 1 },
    ]);
    expect(two).not.toBe(one);
  });

  it("is order-independent", () => {
    const forward = deliveredSecretsFingerprint([
      { name: "A_KEY", value: "v1", updatedAt: 1 },
      { name: "B_KEY", value: "v2", updatedAt: 2 },
    ]);
    const reversed = deliveredSecretsFingerprint([
      { name: "B_KEY", value: "v2", updatedAt: 2 },
      { name: "A_KEY", value: "v1", updatedAt: 1 },
    ]);
    expect(forward).toBe(reversed);
  });

  it("does not contain the value it fingerprints", () => {
    const fp = deliveredSecretsFingerprint([
      { name: "STRIPE_API_KEY", value: "sk_live_51H8xQ2abcdef", updatedAt: 5 },
    ]);
    expect(fp).not.toContain("sk_live");
    expect(fp).toMatch(/^[0-9a-f]+$/);
  });

  it("distinguishes two names whose rotation markers were swapped", () => {
    // The marker is per-NAME, so moving markers between names is a different
    // delivered set even though the multiset of markers matches.
    const a = deliveredSecretsFingerprint([
      { name: "A_KEY", value: "one", updatedAt: 1 },
      { name: "B_KEY", value: "two", updatedAt: 2 },
    ]);
    const b = deliveredSecretsFingerprint([
      { name: "A_KEY", value: "one", updatedAt: 2 },
      { name: "B_KEY", value: "two", updatedAt: 1 },
    ]);
    expect(a).not.toBe(b);
  });

  it("still resumes against a backend that sends no rotation marker", () => {
    // The deploy window: name-only identity, so the session keeps resuming and
    // simply does not fork on rotation until the backend ships. Never a throw,
    // and never a fingerprint that churns every turn.
    const first = deliveredSecretsFingerprint([
      { name: "LEGACY_KEY", value: "v1" },
    ]);
    const second = deliveredSecretsFingerprint([
      { name: "LEGACY_KEY", value: "v2" },
    ]);
    expect(second).toBe(first);
    expect(first).toMatch(/^[0-9a-f]+$/);
  });
});

describe("toSecretEnv", () => {
  it("maps names to values", () => {
    expect(
      toSecretEnv([
        { name: "A_KEY", value: "1" },
        { name: "B_KEY", value: "2" },
      ]),
    ).toEqual({ A_KEY: "1", B_KEY: "2" });
  });

  it("is empty for an empty list, so no call site has to special-case it", () => {
    expect(toSecretEnv([])).toEqual({});
  });
});
