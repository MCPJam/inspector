import { afterEach, expect, it, vi } from "vitest";
import {
  createCompletedTurnTicket,
  readCompletedTurnTicket,
} from "../completed-turn-ticket.js";
import { isPersistRetryHandle } from "../../../shared/persist-receipt.js";
import { deferCompletedTurnLeaseRelease } from "../../utils/completed-turn-finalization.js";
import { randomBytes } from "node:crypto";
const owner = {
  subject: "actor",
  projectId: "project",
  chatSessionId: "chat",
  turnId: "turn",
};
const key = "a sufficiently long fixture key for retry";
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
function ticket(body = '{"messages":"private completed reply"}') {
  vi.stubEnv("HISTORY_PROVENANCE_SECRET", key);
  const value = createCompletedTurnTicket(owner, body);
  expect(value).toBeDefined();
  return value!;
}
it("recovers only the encrypted completed bytes across replicas and key rotation", () => {
  const value = ticket();
  expect(value).not.toContain("private");
  expect(isPersistRetryHandle(value)).toBe(true);
  vi.stubEnv("HISTORY_PROVENANCE_SECRET_PREVIOUS", key);
  vi.stubEnv(
    "HISTORY_PROVENANCE_SECRET",
    "a different sufficiently long replica key",
  );
  expect(readCompletedTurnTicket(value, owner)).toBe(
    '{"messages":"private completed reply"}',
  );
});
it.each(["subject", "projectId", "chatSessionId", "turnId"] as const)(
  "refuses a different %s",
  (field) => {
    expect(
      readCompletedTurnTicket(ticket(), { ...owner, [field]: "other" }),
    ).toBeUndefined();
  },
);
it("refuses expired, tampered and truncated tickets", () => {
  vi.useFakeTimers();
  const value = ticket();
  expect(readCompletedTurnTicket(value.slice(0, -4), owner)).toBeUndefined();
  const parts = value.split(".");
  parts[2] = "A" + parts[2]!.slice(1);
  expect(readCompletedTurnTicket(parts.join("."), owner)).toBeUndefined();
  vi.advanceTimersByTime(30_000);
  expect(readCompletedTurnTicket(value, owner)).toBeUndefined();
});
it("bounds both decompressed and incompressible payloads", () => {
  vi.stubEnv("HISTORY_PROVENANCE_SECRET", key);
  expect(
    createCompletedTurnTicket(owner, "x".repeat(8 * 1024 * 1024 + 1)),
  ).toBeUndefined();
  expect(
    createCompletedTurnTicket(
      owner,
      randomBytes(700 * 1024).toString("base64"),
    ),
  ).toBeUndefined();
});

it("retains the original sidecar lease for the bounded hosted save retry", async () => {
  vi.useFakeTimers();
  const release = vi.fn(async () => undefined), onError = vi.fn();
  expect(deferCompletedTurnLeaseRelease({ outcome: "failed", failureKind: "http_error", retryHandle: ticket() }, release, onError)).toBe(true);
  await vi.advanceTimersByTimeAsync(29_999);
  expect(release).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(release).toHaveBeenCalledOnce();
  expect(onError).not.toHaveBeenCalled();
});
