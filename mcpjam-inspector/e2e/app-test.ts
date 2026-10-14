import { expect, test as base } from "@playwright/test";
import { COMMUNITY_BACKEND } from "./community-backend";
import { prepareApp } from "./visual/app-network";

// Shell, routing, and browser tools need a workspace, not a live guest mint.
// Reuse the visual workspace so parallel CI runs cannot exhaust its daily cap.
// Deployed smoke runs retain real authentication and backend traffic.
export const test = base.extend<{ workspace: void }>({
  workspace: [
    async ({ context, baseURL }, use) => {
      if (process.env.PLAYWRIGHT_BASE_URL) return use();
      const failures = await prepareApp(
        context,
        "light",
        {
          convexOrigin: COMMUNITY_BACKEND.convexUrl.replace("https:", "wss:"),
          localAccessToken: process.env.MCPJAM_SESSION_TOKEN,
          seedOnboarding: false,
        },
        new URL(baseURL!).origin,
      );
      await use();
      expect(
        failures,
        "all workspace operations have explicit fixtures",
      ).toEqual([]);
    },
    { auto: true },
  ],
});
export { expect };
