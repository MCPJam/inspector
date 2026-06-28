import { describe, expect, it } from "vitest";
import { harnessRuntimeFingerprint } from "../run-harness-turn";

// Regression: the fingerprint must be STABLE across turns of one chat so the
// session resumes. App/widget chats mutate the system prompt every turn (live
// widget model context), which previously flipped the fingerprint and
// cold-started every such conversation. The fingerprint must depend only on the
// stable, resume-invalidating dimensions: model + server set + permission mode.
describe("harnessRuntimeFingerprint", () => {
  const base = {
    modelId: "anthropic/claude-opus-4-6",
    selectedServers: ["srv-b", "srv-a"],
    permissionMode: "allow-all",
  };

  it("is identical across turns with the same model + servers (server order-insensitive)", () => {
    const a = harnessRuntimeFingerprint(base);
    const b = harnessRuntimeFingerprint({
      ...base,
      selectedServers: ["srv-a", "srv-b"], // reversed
    });
    expect(a).toBe(b);
  });

  it("changes when the model changes (fork)", () => {
    expect(harnessRuntimeFingerprint(base)).not.toBe(
      harnessRuntimeFingerprint({ ...base, modelId: "anthropic/claude-haiku-4.5" })
    );
  });

  it("changes when the server set changes (fork)", () => {
    expect(harnessRuntimeFingerprint(base)).not.toBe(
      harnessRuntimeFingerprint({ ...base, selectedServers: ["srv-a"] })
    );
  });

  it("does NOT depend on the system prompt (app/widget per-turn injection)", () => {
    // The fn no longer accepts a system prompt; passing a stray field changes
    // nothing — the fingerprint is computed purely from model/servers/mode.
    const withStray = harnessRuntimeFingerprint({
      ...base,
      // @ts-expect-error — systemPrompt is intentionally not a parameter anymore
      systemPrompt: "a wildly different per-turn widget prompt",
    });
    expect(withStray).toBe(harnessRuntimeFingerprint(base));
  });
});
