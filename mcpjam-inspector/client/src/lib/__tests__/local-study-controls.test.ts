import { beforeEach, expect, it, vi } from "vitest";
const fetch = vi.hoisted(() => vi.fn());
vi.mock("../session-token", () => ({ authFetch: fetch }));
import { fetchLocalStudyAdmission, revokeLocalStudyAccess } from "../local-study-controls";
beforeEach(() => { fetch.mockReset(); });
it("reads only typed advisory metadata", async () => {
  fetch.mockResolvedValue(Response.json({ available: { harnessId: "codex", modelSourceReady: true } }));
  expect(await fetchLocalStudyAdmission({ scenarioId: "study", accessVersion: 1 })).toEqual({ harnessId: "codex", modelSourceReady: true });
});
it.each([{ available: true }, { available: { harnessId: "unknown", modelSourceReady: true } }])("refuses malformed advisory metadata", async body => {
  fetch.mockResolvedValue(Response.json(body));
  await expect(fetchLocalStudyAdmission({ scenarioId: "study", accessVersion: 1 })).rejects.toThrow("could not be verified");
});
it("sends only the opaque reservation when revoking", async () => {
  fetch.mockResolvedValue(Response.json({ revoked: true, cleanupComplete: false }));
  expect(await revokeLocalStudyAccess("reservation")).toEqual({ revoked: true, cleanupComplete: false });
  expect(fetch).toHaveBeenCalledWith("/api/mcp/local-harness/study/revoke", expect.objectContaining({ body: JSON.stringify({ reservationId: "reservation" }) }));
});
it("refuses to claim successful cleanup from malformed response", async () => {
  fetch.mockResolvedValue(Response.json({ revoked: true }));
  await expect(revokeLocalStudyAccess("reservation")).rejects.toThrow("could not be confirmed");
});
