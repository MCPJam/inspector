import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), auth: vi.fn() }));
vi.mock("@/lib/session-token", () => ({ authFetch: mocks.fetch }));
vi.mock("@/lib/apis/web/context", () => ({
  getApiAuthorizationHeader: mocks.auth,
}));
vi.mock("@/lib/config", () => ({ HOSTED_MODE: true }));
import {
  extractMarkdownCases,
  saveMarkdownCases,
} from "../markdown-case-import-api";
import { useMCPJamLimitDialogStore } from "@/stores/mcpjam-limit-dialog-store";
const body = {
  projectId: "project",
  suiteId: "suite",
  fileName: "eval-prompt-case-mappings.md",
  markdown: "# Cases\nUser prompt: Find projects\nExpected: Project names",
};
const limitBody = (limitKind: "total" | "concurrency") => ({
  ok: false,
  code: "user_rate_limit",
  limitKind,
  error: "Daily MCPJam model limit reached. Use BYOK or try again tomorrow.",
  organizationId: "org_1",
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue("Bearer user");
  // `notifyLimitHit` only opens while auth is resolved; left at "loading" it
  // stashes the hit instead and every assertion below would read false.
  useMCPJamLimitDialogStore.setState({
    authStatus: "signedIn",
    hasPendingLimit: false,
    outOfCreditsHit: false,
    outOfCreditsOrganizationId: null,
    isOpen: false,
    intent: null,
    organizationId: null,
    surface: null,
    period: null,
    pendingInput: null,
  });
});
it("uses the same-origin extraction proxy so browser CORS is not required", async () => {
  mocks.fetch.mockResolvedValue(
    Response.json({ ok: true, drafts: [], warnings: [] }),
  );
  const signal = new AbortController().signal;
  await expect(extractMarkdownCases(body, signal)).resolves.toMatchObject({
    ok: true,
  });
  expect(mocks.fetch).toHaveBeenCalledWith(
    "/api/web/evals/extract-markdown",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify(body),
      signal,
    }),
  );
});

it("reports an invalid server response without blaming the Markdown", async () => {
  mocks.fetch.mockResolvedValue(
    new Response("<!DOCTYPE html><html>not an API</html>", { status: 200 }),
  );
  await expect(
    extractMarkdownCases(body, new AbortController().signal),
  ).rejects.toThrow("Your Markdown file was not the problem");
});
it("preserves actionable extraction errors", async () => {
  mocks.fetch.mockResolvedValue(
    Response.json(
      { error: "You cannot import cases into this suite." },
      { status: 403 },
    ),
  );
  await expect(
    extractMarkdownCases(body, new AbortController().signal),
  ).rejects.toThrow("You cannot import cases");
});

it("opens the out-of-credits dialog when extraction hits the daily limit", async () => {
  mocks.fetch.mockResolvedValue(
    Response.json(limitBody("total"), { status: 429 }),
  );
  await expect(
    extractMarkdownCases(body, new AbortController().signal),
  ).rejects.toThrow("Daily MCPJam model limit reached");

  const state = useMCPJamLimitDialogStore.getState();
  expect(state.isOpen).toBe(true);
  expect(state.intent).toBe("topup");
  // Read out of the payload, so "Buy credits" routes at the org that was capped.
  expect(state.organizationId).toBe("org_1");
});

it("raises the same wall from the save path", async () => {
  // Both public functions share `readImportResponse`, so the save path — and
  // its second caller in mcpjam-agent/eval-workspace — is covered by the same
  // fix rather than needing its own.
  mocks.fetch.mockResolvedValue(
    Response.json(limitBody("total"), { status: 429 }),
  );
  await expect(
    saveMarkdownCases({
      projectId: "project",
      suiteId: "suite",
      cases: [],
    } as never),
  ).rejects.toThrow("Daily MCPJam model limit reached");
  expect(useMCPJamLimitDialogStore.getState().isOpen).toBe(true);
});

it("leaves a concurrency throttle to its inline retry", async () => {
  // Transient: it clears in seconds and no amount of credit fixes it, so the
  // modal must stay shut even though the message reads like a limit.
  mocks.fetch.mockResolvedValue(
    Response.json(limitBody("concurrency"), { status: 429 }),
  );
  await expect(
    extractMarkdownCases(body, new AbortController().signal),
  ).rejects.toThrow("Daily MCPJam model limit reached");
  expect(useMCPJamLimitDialogStore.getState().isOpen).toBe(false);
});

it("does not open the wall for an ordinary refusal", async () => {
  mocks.fetch.mockResolvedValue(
    Response.json(
      { error: "You cannot import cases into this suite." },
      { status: 403 },
    ),
  );
  await expect(
    extractMarkdownCases(body, new AbortController().signal),
  ).rejects.toThrow("You cannot import cases");
  expect(useMCPJamLimitDialogStore.getState().isOpen).toBe(false);
});
