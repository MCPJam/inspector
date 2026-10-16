import { describe, expect, it } from "vitest";
import { localHarnessCapabilityRefusal } from "../harness-capability-support";

describe("local harness capability support", () => {
  it.each(["claude-code", "codex"])(
    "allows %s native files, commands and supported host tools",
    (harness) => {
      expect(localHarnessCapabilityRefusal(harness, {})).toBeUndefined();
      expect(
        localHarnessCapabilityRefusal(harness, {
          builtInToolIds: ["web_search"],
        }),
      ).toBeUndefined();
    },
  );

  it.each([
    [{ pinnedComputerImageId: "image" }, "a pinned computer image"] as const,
    [{ hasSeededAttachments: true }, "seeded eval attachments"] as const,
    [{ browserToolPolicy: {} }, "a browser tool policy"] as const,
    ...["bash", "browser", "computer", "desktop", "video"].map(
      (id) => [{ builtInToolIds: [id] }, `cloud tools (${id})`] as const,
    ),
  ])(
    "names the unsupported requirement and target choice: %j",
    (requirements, label) => {
      const reason = localHarnessCapabilityRefusal("codex", requirements);
      expect(reason).toContain(`Local Codex cannot provide ${label}`);
      expect(reason).toContain(
        "Choose cloud execution or remove these capabilities.",
      );
    },
  );

  it("lists every unsupported requirement without duplicate tool names", () => {
    const reason = localHarnessCapabilityRefusal("claude-code", {
      hasSeededAttachments: true,
      pinnedComputerImageId: "image",
      builtInToolIds: ["browser", "browser", "bash"],
    });
    expect(reason).toContain(
      "a pinned computer image; seeded eval attachments; cloud tools (browser, bash)",
    );
  });
});
