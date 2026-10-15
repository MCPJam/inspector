import { expect, test } from "@playwright/test";
import { COMMUNITY_BACKEND } from "./community-backend";

// Pins what e2e/community-backend.ts sets up: an inspector this suite boots
// runs against the community backend and cannot reach production. The other
// specs pass on either backend, so without these an edit that dropped an
// override would put the suite back on production silently.
test.describe("a locally booted inspector stays off production", () => {
  test.skip(
    !!process.env.PLAYWRIGHT_BASE_URL,
    "a deployed target is supposed to use its own backend",
  );

  test("the page is served the community Convex URL", async ({ page }) => {
    await page.goto("/");
    const convexUrl = await page.evaluate(
      () =>
        (
          window as unknown as {
            __MCP_RUNTIME_CONFIG__?: { convexUrl?: string };
          }
        ).__MCP_RUNTIME_CONFIG__?.convexUrl,
    );
    expect(convexUrl).toBe(COMMUNITY_BACKEND.convexUrl);
  });

  for (const url of [
    "https://app.mcpjam.com/",
    "https://rt.mcpjam.com/",
    "https://rt-http.mcpjam.com/",
  ]) {
    test(`the browser cannot resolve ${new URL(url).host}`, async ({
      page,
    }) => {
      await expect(page.goto(url)).rejects.toThrow(/ERR_NAME_NOT_RESOLVED/);
    });
  }
});
