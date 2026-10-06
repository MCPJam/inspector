import { describe, expect, it } from "vitest";
import {
  buildHarnessSessionDataPart,
  isHarnessSessionDataPart,
  isHarnessResetDataPart,
} from "../harness-session";

describe("isHarnessSessionDataPart", () => {
  const part = (workdir: unknown) => ({
    type: "data-harness-session",
    data: { workdir },
  });

  it("accepts an absolute workdir", () => {
    expect(isHarnessSessionDataPart(part("/home/user/claude-code-abc"))).toBe(
      true,
    );
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
    expect(isHarnessSessionDataPart({ type: "data-harness-session" })).toBe(
      false,
    );
  });
});

describe("isHarnessResetDataPart", () => {
  it("accepts only the known categorical reasons", () => {
    for (const reason of [
      "sandbox-replaced",
      "legacy-cold-resume",
      "resume-failed",
      "runtime-changed",
    ]) {
      expect(
        isHarnessResetDataPart({
          type: "data-harness-reset",
          data: { reason },
        }),
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

describe("which machine a harness turn ran on", () => {
  it("is `personal` unless the turn ran on the conversation's box", () => {
    expect(
      buildHarnessSessionDataPart({
        workdir: "/home/user/w",
        disposable: false,
      }).data.machine,
    ).toBe("personal");
    expect(
      buildHarnessSessionDataPart({ workdir: "/home/user/w", disposable: true })
        .data.machine,
    ).toBe("disposable");
  });

  it("builds a part the client's own guard accepts", () => {
    for (const disposable of [false, true]) {
      expect(
        isHarnessSessionDataPart(
          buildHarnessSessionDataPart({ workdir: "/home/user/w", disposable }),
        ),
      ).toBe(true);
    }
  });

  it("accepts a part with no machine (a server that predates the field)", () => {
    expect(
      isHarnessSessionDataPart({
        type: "data-harness-session",
        data: { workdir: "/home/user/w" },
      }),
    ).toBe(true);
  });

  it("rejects a machine it does not know", () => {
    expect(
      isHarnessSessionDataPart({
        type: "data-harness-session",
        data: { workdir: "/home/user/w", machine: "somewhere-else" },
      }),
    ).toBe(false);
  });
});
