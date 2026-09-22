import { describe, expect, it } from "vitest";
import {
  isHarnessSessionDataPart,
  isHarnessResetDataPart,
} from "../harness-session";

describe("isHarnessSessionDataPart", () => {
  const part = (workdir: unknown) => ({
    type: "data-harness-session",
    data: { workdir },
  });

  it("accepts an absolute workdir", () => {
    expect(
      isHarnessSessionDataPart(part("/home/user/claude-code-abc")),
    ).toBe(true);
  });

  it("rejects relative and whitespace-padded workdirs (cwd would drift)", () => {
    expect(isHarnessSessionDataPart(part(""))).toBe(false);
    expect(isHarnessSessionDataPart(part("./project"))).toBe(false);
    expect(isHarnessSessionDataPart(part("project"))).toBe(false);
    expect(isHarnessSessionDataPart(part(" /home/user "))).toBe(false);
    expect(isHarnessSessionDataPart(part("   "))).toBe(false);
    expect(isHarnessSessionDataPart(part(42))).toBe(false);
  });

  it("rejects wrong type/shape", () => {
    expect(isHarnessSessionDataPart(null)).toBe(false);
    expect(isHarnessSessionDataPart({ type: "data-other", data: {} })).toBe(
      false,
    );
    expect(
      isHarnessSessionDataPart({ type: "data-harness-session" }),
    ).toBe(false);
  });
});

describe("isHarnessResetDataPart", () => {
  it("accepts only the known categorical reasons", () => {
    for (const reason of [
      "sandbox-replaced",
      "legacy-cold-resume",
      "resume-failed",
    ]) {
      expect(
        isHarnessResetDataPart({ type: "data-harness-reset", data: { reason } }),
      ).toBe(true);
    }
    expect(
      isHarnessResetDataPart({
        type: "data-harness-reset",
        data: { reason: "sandbox-id-e2b-123" },
      }),
    ).toBe(false);
  });
});
