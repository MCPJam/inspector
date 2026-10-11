import { beforeEach, expect, it, vi } from "vitest";
const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock("@/lib/session-token", () => ({ authFetch }));
// Shared node_modules resolve the primary checkout; exercise this worktree's real SDK.
vi.mock(
  "@mcpjam/sdk/platform",
  async () => import("../../../../../../sdk/src/platform/index.js"),
);
import {
  deleteScope,
  recoverDeletion,
  DeletionOutcomeUnknown,
} from "../deletion-api";

const scope = { type: "project" as const, id: "synthetic-project" };
const storedKey =
  "mcpjam:deletion-request:synthetic-actor:project:synthetic-project";
const receipt = { requestId: "synthetic-receipt" };
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
beforeEach(() => {
  localStorage.clear();
  vi.resetAllMocks();
});

it("replays an uncertain saved key through the actual SDK after new intake is disabled", async () => {
  let available = true;
  authFetch.mockImplementation(async (input: RequestInfo | URL) => {
    const path = new URL(String(input), window.location.origin).pathname;
    if (path.endsWith("/me")) return json({ id: "synthetic-actor" });
    if (path.endsWith("/capabilities"))
      return json({
        available,
        protocolVersion: 1,
        scopeTypes: ["project", "organization"],
      });
    if (path.endsWith("/replay")) return json(receipt);
    throw new Error("Lost intake response");
  });
  const legacy = vi.fn();
  await expect(deleteScope(scope, legacy)).rejects.toBeInstanceOf(
    DeletionOutcomeUnknown,
  );
  const key = localStorage.getItem(storedKey);
  expect(key).toBeTruthy();
  const before = authFetch.mock.calls.length;
  available = false;
  expect(
    await recoverDeletion(
      "?type=project&id=synthetic-project",
      async () => "synthetic-token",
    ),
  ).toEqual(receipt);
  const replay = authFetch.mock.calls.slice(before);
  expect(
    replay.map(
      ([input]) => new URL(String(input), window.location.origin).pathname,
    ),
  ).toEqual(["/api/v1/me", "/api/v1/deletions/replay"]);
  expect(new Headers(replay[1][1]?.headers).get("Idempotency-Key")).toBe(key);
  expect(localStorage.getItem(storedKey)).toBeNull();
  expect(legacy).not.toHaveBeenCalled();
});

it("preserves a replay miss while the original request may still be arriving", async () => {
  localStorage.setItem(storedKey, "original-synthetic-key");
  authFetch.mockImplementation(async (input: RequestInfo | URL) => {
    const path = new URL(String(input), window.location.origin).pathname;
    if (path.endsWith("/me")) return json({ id: "synthetic-actor" });
    if (path.endsWith("/replay"))
      return json(
        { code: "NOT_FOUND", message: "Deletion request not found" },
        404,
      );
    throw new Error("New intake must not be called");
  });
  const legacy = vi.fn();
  await expect(deleteScope(scope, legacy)).rejects.toMatchObject({
    status: 404,
  });
  expect(localStorage.getItem(storedKey)).toBe("original-synthetic-key");
  expect(legacy).not.toHaveBeenCalled();
  expect(
    authFetch.mock.calls.map(
      ([input]) => new URL(String(input), window.location.origin).pathname,
    ),
  ).not.toContain("/api/v1/deletions");
});
