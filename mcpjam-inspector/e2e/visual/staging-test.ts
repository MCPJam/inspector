import { test as base } from "@playwright/test";

export { expect } from "@playwright/test";

export const test = base.extend({
  context: async ({ context }, use) => {
    try {
      await use(context);
    } finally {
      // Block browser traffic before removing guards, then close the context
      // to cancel proxy reads instead of waiting on an unanswered upstream.
      await context.setOffline(true);
      await context.unrouteAll({ behavior: "ignoreErrors" });
      await context.close();
    }
  },
});
