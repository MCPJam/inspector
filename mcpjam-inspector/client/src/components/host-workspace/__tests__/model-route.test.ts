import { describe, expect, it } from "vitest";
import { shouldUseOwnedExtensionModelRoute } from "../model-route";
const admitted = { flag: true, admitted: true, extensionsEnabled: true, hostId: "saved", actorId: "member" };
describe("owned extension model routing", () => {
  it("routes admitted saved workspaces with plugin extensions on through web authority", () => {
    expect(shouldUseOwnedExtensionModelRoute(admitted)).toBe(true);
  });
  it("routes a native Codex client there too, so its forms and Apps are owned", () => {
    expect(shouldUseOwnedExtensionModelRoute({ ...admitted, harness: "codex" })).toBe(true);
  });
  it.each([{ flag: false }, { admitted: false }, { extensionsEnabled: false }, { hostId: null }, { actorId: null }, { harness: "claude-code" }])("preserves existing routing when ownership is unavailable: %j", (change) => {
    expect(shouldUseOwnedExtensionModelRoute({ ...admitted, ...change })).toBe(false);
  });
});
