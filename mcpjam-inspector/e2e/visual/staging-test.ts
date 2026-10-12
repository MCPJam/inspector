import { test as base } from "@playwright/test";

export { expect } from "@playwright/test";

export const test = base.extend({
  context: async ({ context }, use) => {
    try {
      await use(context);
    } finally {
      // The staging proxy fetches background reads outside the page lifecycle.
      // Finish those callbacks before Playwright disposes their request context.
      await context.unrouteAll({ behavior: "wait" });
    }
  },
});
