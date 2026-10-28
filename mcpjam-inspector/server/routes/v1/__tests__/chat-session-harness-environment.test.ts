import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveApiHarnessEnvironment } from "../chat-session-harness-environment.js";
import { resolvePlaygroundCredentialEnvironment } from "../../../utils/harness/playground-box.js";

vi.mock("../../../utils/harness/playground-box.js", () => ({
  resolvePlaygroundCredentialEnvironment: vi.fn(),
}));
const base = {
  projectId: "project",
  bearer: "Bearer token",
  hostId: "host",
  harnessId: "claude-code",
  credential: false,
};
beforeEach(() => vi.clearAllMocks());
describe("API harness grant identity", () => {
  it("does not move a plain host conversation onto its new composed trace environment", async () => {
    expect(
      await resolveApiHarnessEnvironment({
        ...base,
        resolvedEnvironmentId: "composed",
      }),
    ).toEqual({ ok: true, environmentId: undefined });
    expect(resolvePlaygroundCredentialEnvironment).not.toHaveBeenCalled();
  });
  it("retains an explicitly pinned environment", async () => {
    expect(
      await resolveApiHarnessEnvironment({
        ...base,
        pinnedEnvironmentId: "named",
        resolvedEnvironmentId: "composed",
      }),
    ).toEqual({ ok: true, environmentId: "named" });
  });
  it("uses the modern credential composition without composing it again", async () => {
    expect(
      await resolveApiHarnessEnvironment({
        ...base,
        credential: true,
        resolvedEnvironmentId: "credential",
      }),
    ).toEqual({ ok: true, environmentId: "credential" });
    expect(resolvePlaygroundCredentialEnvironment).not.toHaveBeenCalled();
  });
  it("preserves credential composition on an older backend", async () => {
    vi.mocked(resolvePlaygroundCredentialEnvironment).mockResolvedValue({
      ok: true,
      environmentId: "legacy-credential",
    });
    expect(
      await resolveApiHarnessEnvironment({
        ...base,
        credential: true,
        harnessId: "cursor",
      }),
    ).toEqual({ ok: true, environmentId: "legacy-credential" });
    expect(resolvePlaygroundCredentialEnvironment).toHaveBeenCalledWith({
      projectId: "project",
      hostId: "host",
      bearer: "Bearer token",
      harnessId: "cursor",
    });
  });
});
