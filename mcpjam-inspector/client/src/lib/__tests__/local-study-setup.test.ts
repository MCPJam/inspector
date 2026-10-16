import { beforeEach, expect, it, vi } from "vitest";
const fetch = vi.hoisted(() => vi.fn());
vi.mock("../session-token", () => ({ authFetch: fetch }));
import { requestLocalStudySetup } from "../local-study-setup";
const args = { scenarioId: "study", accessVersion: 1, chatSessionId: "chat" };
const ready = {
  state: "ready",
  token: "secret",
  expiresAt: "2999-01-01T00:00:00.000Z",
  workspaceDisplayRoot: "~/study",
  target: {
    kind: "local-native",
    harnessId: "codex",
    machineId: "machine",
    workspaceGrantId: "workspace",
    runtimeId: "runtime",
    permissionProfile: "workspace-edits",
    policyVersion: "policy",
    localStudySessionId: "reservation",
  },
};
beforeEach(() => {
  fetch.mockReset();
});
it("sends explicit authorization and reads opaque target ids", async () => {
  fetch.mockResolvedValue(Response.json(ready));
  expect(await requestLocalStudySetup(args)).toEqual(ready);
  expect(fetch).toHaveBeenCalledWith(
    "/api/mcp/local-harness/study/setup",
    expect.objectContaining({
      body: JSON.stringify({ ...args, accepted: true }),
    }),
  );
});
it.each([
  { ...ready, token: "" },
  { ...ready, expiresAt: "2000-01-01T00:00:00.000Z" },
  { ...ready, target: { ...ready.target, localStudySessionId: undefined } },
])("refuses malformed/expired local authority", async (body) => {
  fetch.mockResolvedValue(Response.json(body));
  await expect(requestLocalStudySetup(args)).rejects.toThrow(
    "unavailable or expired",
  );
});
it("surfaces install progress without a credential", async () => {
  fetch.mockResolvedValue(
    Response.json({ state: "installing" }, { status: 202 }),
  );
  await expect(requestLocalStudySetup(args)).rejects.toThrow("installing");
});
it("preserves actionable server errors", async () => {
  fetch.mockResolvedValue(
    Response.json({ error: "Choose and save a model source" }, { status: 409 }),
  );
  await expect(requestLocalStudySetup(args)).rejects.toThrow("Choose and save");
});
