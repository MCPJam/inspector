import { describe, expect, it } from "vitest";
import { localHarnessCapabilityRefusal } from "@/shared/harness-capability-support";
import { checkHarnessRuntimeAvailable } from "../../../utils/harness/harness-availability";
import { assertLocalHarnessCapabilities } from "../../../utils/harness/local/run-resources";
import {
  checkEvalExecutionAdmission,
  checkEvalHarnessAdmission,
  checkEvalHarnessStaticAdmission,
} from "../harness-admission";

describe("capability admission uses the execution decision", () => {
  it.each(["claude-code", "codex"] as const)(
    "refuses injected tools for %s before model and computer checks",
    (harness) => {
      const capabilities = { builtInToolIds: ["browser", "bash"] };
      const reason = localHarnessCapabilityRefusal(harness, capabilities);
      const hostConfig = { harness, ...capabilities };
      expect(
        checkHarnessRuntimeAvailable({
          harnessId: harness,
          localExecution: true,
          capabilities,
          model: { id: "invalid" },
          requireToolApproval: false,
          hasSelectedMcpServers: false,
        }),
      ).toEqual({ ok: false, kind: "capability-unsupported", reason });
      expect(
        checkEvalHarnessStaticAdmission({ hostConfig, localExecution: true }),
      ).toEqual({ ok: false, harness, reason });
      expect(
        checkEvalHarnessAdmission({
          hostConfig,
          localExecution: true,
          cases: [],
        }),
      ).toEqual({ ok: false, harness, reason });
      expect(
        checkEvalExecutionAdmission({ hostConfig, localExecution: true }),
      ).toEqual({ ok: false, reason });
      expect(() =>
        assertLocalHarnessCapabilities({ harnessId: harness, ...capabilities }),
      ).toThrow(reason);
    },
  );

  it("refuses seeded attachments from the frozen case configuration", () => {
    expect(
      checkEvalHarnessAdmission({
        hostConfig: { harness: "codex" },
        localExecution: true,
        cases: [{ attachments: [{ id: "frozen-attachment" }] }],
      }),
    ).toEqual({
      ok: false,
      harness: "codex",
      reason: localHarnessCapabilityRefusal("codex", {
        hasSeededAttachments: true,
      }),
    });
  });

  it("refuses a local image even with no injected tools, while cloud remains supported", () => {
    const request = {
      hostConfig: { harness: "codex" },
      pinnedComputerImageId: "image",
    };
    expect(
      checkEvalExecutionAdmission({ ...request, localExecution: true }),
    ).toEqual({
      ok: false,
      reason: localHarnessCapabilityRefusal("codex", {
        pinnedComputerImageId: "image",
      }),
    });
    expect(
      checkEvalExecutionAdmission({ ...request, localExecution: false }),
    ).toEqual({ ok: true });
  });
});
