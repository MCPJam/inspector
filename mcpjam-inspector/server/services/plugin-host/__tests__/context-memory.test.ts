import { describe, expect, it } from "vitest";
import { PluginContextMemory } from "../context-memory.js";

const app = (instanceId: string, actorId = "actor") => ({
  owner: { instanceId, actorId },
  subject: "subject",
});

describe("App context memory", () => {
  it("refuses growth past either budget, never a restore or a shrink", () => {
    const memory = new PluginContextMemory(100, 150);
    memory.hold(app("a"), 80);
    expect(() => memory.check(app("b"), 30)).toThrow(
      "PLUGIN_CONTEXT_MEMORY_LIMIT",
    );
    memory.check(app("b"), 20);
    // Context already admitted is counted, even past the budget.
    memory.hold(app("b"), 60);
    memory.check(app("b"), 10);
    // Another actor still meets the process budget.
    memory.check(app("c", "other"), 10);
    expect(() => memory.check(app("c", "other"), 11)).toThrow(
      "PLUGIN_CONTEXT_MEMORY_LIMIT",
    );
    memory.release("b");
    memory.check(app("c", "other"), 70);
    memory.check(app("b"), 20);
  });
});
