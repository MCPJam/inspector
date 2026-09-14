/**
 * The gate, and what a failure means.
 *
 * Both properties are the kind that no behavioural test elsewhere would catch:
 * an unconditional fetch still returns the right list, and a tri-state leaked
 * from the harness path still looks like "no secrets" — right up until a
 * transient Convex failure types a literal placeholder into a login form.
 */
import { describe, expect, it, vi } from "vitest";

const fetchRuntimeSecrets = vi.hoisted(() => vi.fn());
vi.mock("../../harness/runtime-secrets.js", () => ({ fetchRuntimeSecrets }));

import { resolveBrowserSecrets } from "../browser-secrets";

const ON = { MCPJAM_BROWSER_SECRET_PLACEHOLDERS: "1" } as NodeJS.ProcessEnv;
const OFF = {} as NodeJS.ProcessEnv;

describe("resolveBrowserSecrets", () => {
  it("asks for NOTHING while the flag is off", async () => {
    // The property that makes this safe to call per eval iteration: off, it is
    // not a cheap fetch, it is no fetch — no round trip and no KMS decrypt.
    fetchRuntimeSecrets.mockClear();
    expect(
      await resolveBrowserSecrets({
        bearer: "b",
        projectId: "p",
        environmentId: "e",
        env: OFF,
      }),
    ).toEqual([]);
    expect(fetchRuntimeSecrets).not.toHaveBeenCalled();
  });

  it("does not fetch when the turn already resolved its secrets", async () => {
    // ONE READ PER TURN: two are two decrypts, and a window where they disagree.
    fetchRuntimeSecrets.mockClear();
    const resolved = [{ name: "A", value: "v" }];
    expect(
      await resolveBrowserSecrets({ resolved, env: ON }),
    ).toBe(resolved);
    expect(fetchRuntimeSecrets).not.toHaveBeenCalled();
  });

  it("takes an already-resolved EMPTY list as an answer, not as absence", async () => {
    fetchRuntimeSecrets.mockClear();
    expect(await resolveBrowserSecrets({ resolved: [], env: ON })).toEqual([]);
    expect(fetchRuntimeSecrets).not.toHaveBeenCalled();
  });

  it("fetches when the flag is on and nothing is resolved", async () => {
    fetchRuntimeSecrets.mockClear();
    fetchRuntimeSecrets.mockResolvedValue({
      ok: true,
      secrets: [{ name: "A", value: "v" }],
    });
    expect(
      await resolveBrowserSecrets({
        bearer: "b",
        projectId: "p",
        environmentId: "e",
        env: ON,
      }),
    ).toEqual([{ name: "A", value: "v" }]);
    expect(fetchRuntimeSecrets).toHaveBeenCalledWith("b", {
      projectId: "p",
      environmentId: "e",
    });
  });

  it("treats a FAILED fetch as no secrets", async () => {
    // Deliberately NOT the harness's tri-state. There the two answers differ;
    // here both end in a refusal and nothing typed, which is the safe outcome.
    fetchRuntimeSecrets.mockClear();
    fetchRuntimeSecrets.mockResolvedValue({ ok: false });
    expect(
      await resolveBrowserSecrets({
        bearer: "b",
        projectId: "p",
        environmentId: "e",
        env: ON,
      }),
    ).toEqual([]);
  });
});
