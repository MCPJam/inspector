import { test, expect } from "@playwright/test";
import { buildSync } from "esbuild";
import { fileURLToPath } from "node:url";

// Real SDK persistence and its React flag hook, in same-origin browser tabs.
// Identity/evaluation inputs are fixtures, not an authenticated product run.
const bundle = buildSync({
  stdin: {
    contents: `
      import React from "react";
      import { createRoot } from "react-dom/client";
      import { PostHog } from "posthog-js";
      import { PostHogProvider, useFeatureFlagEnabled } from "posthog-js/react";
      import { getPostHogTabStorageOptions } from "./client/src/lib/posthog-tab-storage";
      const client = new PostHog();
      client.init("fixture-key", {
        ...(location.search ? { persistence: "localStorage+cookie" } : getPostHogTabStorageOptions()),
        advanced_disable_feature_flags: true,
        advanced_disable_feature_flags_on_first_load: true,
        disable_external_dependency_loading: true,
        opt_out_capturing_by_default: true,
        capture_pageview: false,
        bootstrap: { distinctID: "owner", isIdentifiedID: true,
          featureFlags: { "sandbox-images-enabled": true } },
      });
      function RouteGuard() {
        const enabled = useFeatureFlagEnabled("sandbox-images-enabled");
        return React.createElement("div", { id: "route" },
          enabled === undefined ? "loading" : enabled ? "dashboard" : "unavailable");
      }
      createRoot(document.getElementById("root")).render(
        React.createElement(PostHogProvider, { client }, React.createElement(RouteGuard)));
      window.changeActor = (actor, enabled, reset) => {
        if (reset) client.reset();
        client.identify(actor);
        client.updateFlags({ "sandbox-images-enabled": enabled });
      };
    `,
    resolveDir: fileURLToPath(new URL("..", import.meta.url)),
  },
  bundle: true,
  write: false,
  define: { "process.env.NODE_ENV": '"test"' },
}).outputFiles[0].text;

test("actor refresh and signed-out reset do not replace another tab's route flags", async ({ context }) => {
  await context.route("**/*", (route) => route.fulfill({
    contentType: "text/html",
    body: '<div id="root"></div>',
  }));
  const owner = await context.newPage();
  const participant = await context.newPage();
  for (const page of [owner, participant]) {
    await page.goto("http://posthog-tabs.test/");
    await page.addScriptTag({ content: bundle });
    await expect(page.locator("#route")).toHaveText("dashboard");
  }
  await owner.evaluate(() => {
    window.addEventListener("storage", (event) => {
      if (event.key === "witness") document.body.dataset.witness = event.newValue ?? "";
    });
  });
  await participant.evaluate(() => {
    Reflect.get(window, "changeActor")("participant", false, false);
    localStorage.setItem("witness", "refresh");
  });
  await expect(owner.locator("body")).toHaveAttribute("data-witness", "refresh");
  await expect(participant.locator("#route")).toHaveText("unavailable");
  await owner.evaluate(() => {
    window.dispatchEvent(new StorageEvent("storage", {
      key: "ph_fixture-key_posthog",
      storageArea: localStorage,
      newValue: JSON.stringify({ distinct_id: "owner", $enabled_feature_flags: {} }),
    }));
  });
  await expect(owner.locator("#route")).toHaveText("dashboard");
  await participant.evaluate(() => {
    Reflect.get(window, "changeActor")("guest", false, true);
    localStorage.setItem("witness", "reset");
  });
  await expect(owner.locator("body")).toHaveAttribute("data-witness", "reset");
  await expect(participant.locator("#route")).toHaveText("unavailable");
  await expect(owner.locator("#route")).toHaveText("dashboard");
  await participant.evaluate(() => localStorage.removeItem("witness"));
  await owner.reload();
  await owner.addScriptTag({ content: bundle });
  await expect(owner.locator("#route")).toHaveText("dashboard");
  expect(await owner.evaluate(() => Object.keys(localStorage))).toEqual([]);
});

test("the same SDK reproduces the shared-storage route loss without tab isolation", async ({ context }) => {
  await context.route("**/*", (route) => route.fulfill({
    contentType: "text/html", body: '<div id="root"></div>',
  }));
  const owner = await context.newPage();
  const participant = await context.newPage();
  for (const page of [owner, participant]) {
    await page.goto("http://posthog-tabs.test/?legacy");
    await page.addScriptTag({ content: bundle });
    await expect(page.locator("#route")).toHaveText("dashboard");
  }
  await participant.evaluate(() => {
    Reflect.get(window, "changeActor")("owner", false, false);
  });
  await expect(owner.locator("#route")).toHaveText("unavailable");
});
