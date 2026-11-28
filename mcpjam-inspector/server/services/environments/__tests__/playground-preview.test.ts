import { describe, expect, it } from "vitest";
import { toPlaygroundEnvironmentPreview } from "../playground-preview";
import type { ResolvedEnvironmentRuntime } from "../runtime";

const spec = (
  runtimeConfig: Record<string, unknown>,
): ResolvedEnvironmentRuntime => ({
  environmentRef: { environmentId: "env_1", name: "Staging", revision: 7 },
  host: { hostId: "host_1", runtimeConfig },
  servers: { effectiveServerIds: [] },
  skills: [
    {
      skillId: "sk_1",
      name: "release-notes",
      description: "Write notes",
      content: "# Notes",
      aggregateHash: "agg1",
      channels: ["environment"],
    },
  ],
});

const delivery = (runtimeConfig: Record<string, unknown>) =>
  toPlaygroundEnvironmentPreview(spec(runtimeConfig)).capabilities
    .skillDelivery;

describe("the Playground environment preview's skill delivery", () => {
  it("follows the engine the turn runs on", () => {
    expect(delivery({ modelId: "openai/gpt-5-mini" })).toBe("emulated");
    expect(delivery({ harness: "claude-code" })).toBe("harness");
    expect(delivery({ harness: "cursor" })).toBe("harness");
    // A client on the Codex loop sets `agentLoop`, not `harness`; the turn
    // runs Codex, so the preview must not say "emulated" for it.
    expect(delivery({ modelId: "openai/gpt-5.5", agentLoop: "codex" })).toBe(
      "harness",
    );
  });

  it("says a harness without a skill channel takes none of the skills", () => {
    // Saying "harness" here would claim a delivery that never happens. A
    // harness id this Inspector doesn't know has no channel it can name.
    expect(delivery({ harness: "not-a-harness" })).toBe("unsupported");
  });
});
