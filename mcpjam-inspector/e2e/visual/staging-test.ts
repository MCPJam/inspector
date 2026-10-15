import { test as base } from "@playwright/test";

export { expect } from "@playwright/test";

export const test = base.extend({
  context: async ({ context }, use) => {
    try {
      await use(context);
    } finally {
      // Stop new browser traffic, then finish proxy callbacks before Playwright
      // disposes the request context they use for background reads.
      await context.setOffline(true);
      await context.unrouteAll({ behavior: "wait" });
    }
  },
});
