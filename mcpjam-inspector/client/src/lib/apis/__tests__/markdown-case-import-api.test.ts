import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), auth: vi.fn() }));
vi.mock("@/lib/session-token", () => ({ authFetch: mocks.fetch }));
vi.mock("@/lib/apis/web/context", () => ({
  getApiAuthorizationHeader: mocks.auth,
}));
vi.mock("@/lib/config", () => ({ HOSTED_MODE: true }));
import { extractMarkdownCases } from "../markdown-case-import-api";
const body = {
  projectId: "project",
  suiteId: "suite",
  fileName: "eval-prompt-case-mappings.md",
  markdown: "# Cases\nUser prompt: Find projects\nExpected: Project names",
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue("Bearer user");
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
