import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { requestLocalStudyReservation } from "../study-access.js";

const fetchMock = vi.fn();
const request = {
  action: "validate" as const,
  reservationId: "reservation",
  machineId: "machine",
  keyId: "key",
};
const reservation = {
  reservationId: "reservation",
  projectId: "project",
  scenarioId: "study",
  chatSessionId: "chat",
  accessVersion: 1,
  expiresAt: Date.now() + 60_000,
};
beforeEach(() => {
  vi.stubEnv("CONVEX_HTTP_URL", "https://backend.test");
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  fetchMock.mockReset();
});

it("uses the bearer and validates the returned reservation", async () => {
  fetchMock.mockResolvedValue(Response.json({ ok: true, reservation }));
  await expect(
    requestLocalStudyReservation("bearer", request),
  ).resolves.toEqual(reservation);
  expect(fetchMock).toHaveBeenCalledWith(
    new URL("https://backend.test/web/scenario/local-session"),
    expect.objectContaining({
      headers: {
        authorization: "Bearer bearer",
        "content-type": "application/json",
      },
      body: JSON.stringify(request),
    }),
  );
});

it.each([
  { ok: false },
  { ok: true, reservation: { ...reservation, chatSessionId: "" } },
  { ok: true, reservation: { ...reservation, expiresAt: 0 } },
])("refuses denied, malformed or expired responses", async (body) => {
  fetchMock.mockResolvedValue(Response.json(body));
  await expect(requestLocalStudyReservation("bearer", request)).rejects.toThrow(
    "could not be authorized",
  );
});

it("propagates transport failure without granting access", async () => {
  fetchMock.mockRejectedValue(new Error("Backend offline"));
  await expect(requestLocalStudyReservation("bearer", request)).rejects.toThrow(
    "Backend offline",
  );
});
