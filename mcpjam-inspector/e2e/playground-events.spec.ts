import { MCPClientManager } from "@mcpjam/sdk";
import { expect, test, type Page } from "@playwright/test";

// Run against a disposable Jamroom app with mcp-events-enabled. Local mode
// covers poll/push; MCP_EVENTS_E2E_MODE=hosted needs a public inbox receiver.
// The demo's short-lived bearer and WorkOS session never enter a trace/video.
const storageState = process.env.MCP_EVENTS_E2E_STORAGE_STATE;
const projectId = process.env.MCP_EVENTS_E2E_PROJECT_ID;
const hosted = process.env.MCP_EVENTS_E2E_MODE === "hosted";
test.use({ storageState, trace: "off", video: "off" });
test.skip(
  !storageState || !projectId,
  "Requires Jamroom storage state and project ID",
);
test.afterEach(async ({ context }) => {
  // WorkOS rotates refresh credentials; preserve them for a subsequent run.
  if (storageState) await context.storageState({ path: storageState });
});

const instructions =
  "Reply with EVENT_ACK followed by the value of data.message. Do not call any tools.";
async function waitForReply(page: Page, message: string) {
  await expect(
    page.getByText(`EVENT_ACK ${message}`, { exact: true }),
  ).toHaveCount(1, { timeout: 60_000 });
  await expect(
    page.getByRole("button", { name: "Stop generating", exact: true }),
  ).toHaveCount(0, { timeout: 60_000 });
}

async function chooseClient(page: Page, name: string) {
  await page.getByTestId("client-selector-trigger").click();
  const option = page.getByRole("option").filter({ hasText: name }).first();
  await expect(option).toBeVisible();
  await option.hover();
  const only = page.getByRole("button", {
    name: `Use only ${name}`,
    exact: true,
  });
  if (await only.isVisible()) await only.click();
  else await option.click();
  await expect(page.getByTestId("client-selector-trigger")).toHaveText(name);
}

async function openEvent(page: Page, serverName: string) {
  await page
    .locator("button[aria-pressed]")
    .filter({ hasText: /^Events$/ })
    .click();
  await page.getByRole("button", { name: "Add event", exact: true }).click();
  await page
    .getByRole("dialog")
    .locator("section")
    .filter({
      has: page.getByRole("heading", { name: serverName, exact: true }),
    })
    .getByRole("button", { name: /demo.ping/ })
    .click();
  await page.getByLabel("Instructions", { exact: true }).fill(instructions);
}

async function triggerTest(page: Page, message: string) {
  await page
    .getByRole("region", { name: "demo.ping connection" })
    .getByRole("button", { name: "Trigger event", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Test event data").fill(JSON.stringify({ message }));
  await dialog
    .getByRole("button", { name: "Trigger event", exact: true })
    .click();
  await waitForReply(page, message);
}

test("demo events reach the Playground agent through real delivery and test injection", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(300_000);
  page.setDefaultTimeout(30_000);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  for (const name of ["Not now", "Keep dark"]) {
    await page.addLocatorHandler(
      page.getByRole("button", { name, exact: true }),
      async (button) => {
        await button.click();
      },
    );
  }
  await page.goto(`/p/${projectId}/servers`);
  await page.getByRole("button", { name: "Add Server", exact: true }).click();
  const response = await request.post("https://mcp-events.mcpjam.com/sessions");
  expect(response.ok()).toBe(true);
  const session: { url: string; token: string } = await response.json();
  const serverName = `Events E2E ${Date.now()}`;
  const dialog = page.getByRole("dialog");
  await dialog.getByPlaceholder("my-mcp-server").fill(serverName);
  await dialog
    .getByPlaceholder(
      hosted ? "https://example.com/mcp" : "http://localhost:8080/mcp",
    )
    .fill(session.url);
  await dialog
    .getByRole("combobox", { name: "Authentication", exact: true })
    .click();
  await page.getByRole("option", { name: "Bearer Token", exact: true }).click();
  await dialog.getByPlaceholder("Enter your bearer token").fill(session.token);
  const connected = page.waitForResponse(
    (result) =>
      new URL(result.url()).pathname ===
        (hosted ? "/api/web/servers/validate" : "/api/mcp/connect") &&
      (hosted || result.request().postDataJSON()?.serverName === serverName),
  );
  await dialog.getByRole("button", { name: "Add Server", exact: true }).click();
  expect((await connected).ok()).toBe(true);
  await expect(dialog).not.toBeVisible();
  await page.getByRole("button", { name: "Playground", exact: true }).click();
  await expect(page.getByTestId("client-selector-trigger")).toBeVisible({
    timeout: 45_000,
  });
  await chooseClient(page, "MCPJam");

  const emitter = new MCPClientManager();
  try {
    await emitter.connectToServer("demo", {
      url: session.url,
      accessToken: session.token,
      mcpProtocolVersion: "2026-07-28",
    });
    for (const mode of hosted ? ["Webhook"] : ["Poll", "Push"]) {
      await openEvent(page, serverName);
      const configure = page.getByRole("dialog");
      await configure
        .locator("summary")
        .filter({ hasText: /^Delivery/ })
        .click();
      await configure.getByRole("radio", { name: mode, exact: true }).check();
      await configure
        .getByRole("button", { name: "Add event", exact: true })
        .click();
      await expect(configure).not.toBeVisible();
      const binding = page.getByRole("region", {
        name: "demo.ping connection",
      });
      await expect(binding).toContainText("Listening", { timeout: 45_000 });
      await triggerTest(page, `manual-${mode}`);
      const message = `server-${mode}`;
      const emitted = await emitter.executeTool("demo", "emit_ping", {
        message,
      });
      expect(emitted.isError).not.toBe(true);
      await waitForReply(page, message);
      await binding.getByRole("button", { name: "Pause", exact: true }).click();
      await expect(
        binding.getByRole("button", { name: "Trigger event", exact: true }),
      ).toBeDisabled();
      await binding
        .getByRole("button", { name: "Resume", exact: true })
        .click();
      await expect(binding).toContainText("Listening");
      await page.screenshot({
        path: testInfo.outputPath(`events-${mode.toLowerCase()}.png`),
      });
      await binding.getByRole("button", { name: "Edit", exact: true }).click();
      await page
        .getByRole("button", { name: "Disconnect from agent", exact: true })
        .click();
      await expect(binding).toHaveCount(0);
    }
  } finally {
    await emitter.disconnectAllServers();
  }

  // A client without Events support can accept an explicitly labelled test
  // message. This does not qualify any vendor harness's native Events support.
  if (!hosted) {
    // A saved conversation restores its own client. Start a fresh one before
    // selecting a different client for the test-only case.
    await page.getByRole("button", { name: "Clear chat", exact: true }).click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Clear chat", exact: true })
      .click();
    await expect(page.getByRole("alertdialog")).not.toBeVisible();
    await expect(
      page.getByText("EVENT_ACK server-Push", { exact: true }),
    ).toHaveCount(0);
    await chooseClient(page, "Claude");
    // Finish the client's conversation transition before attaching a binding.
    // Switching clients pauses bindings that belong to the previous scope.
    const composer = page
      .getByTestId("chat-input-composer")
      .getByRole("textbox");
    await composer.fill(
      "Reply with EVENT_ACK ready-client. Do not call tools.",
    );
    await composer.press("Enter");
    await waitForReply(page, "ready-client");
    await openEvent(page, serverName);
    await page
      .getByRole("button", { name: "Add test event", exact: true })
      .click();
    await expect(
      page.getByRole("region", { name: "demo.ping connection" }),
    ).toContainText("Test only");
    await triggerTest(page, "test-only");
    await page.screenshot({
      path: testInfo.outputPath("events-test-only.png"),
    });
  }

  await page.goto(`/p/${projectId}/triggers`);
  await expect(page).toHaveURL(
    /\/playground\?panel=events&background=1(?:&|$)/,
    { timeout: 45_000 },
  );
  await expect(
    page
      .getByRole("dialog")
      .getByRole("heading", { name: "Background triggers" }),
  ).toBeVisible();
  await expect(page.getByRole("dialog")).toContainText("No triggers yet");
  if (hosted) {
    const rules = page.getByRole("dialog");
    await rules
      .getByRole("button", { name: "New trigger", exact: true })
      .first()
      .click();
    const ruleName = `Saved event rule ${Date.now()}`;
    await rules.getByLabel("Name", { exact: true }).fill(ruleName);
    await rules
      .getByLabel("Instructions", { exact: true })
      .fill("Reply with LEGACY_ACK. Do not call tools.");
    await rules
      .getByRole("button", { name: "Create trigger", exact: true })
      .click();
    await rules.getByRole("switch", { name: "Enabled", exact: true }).click();
    await expect(
      rules.getByRole("switch", { name: "Disabled", exact: true }),
    ).not.toBeChecked();
    await rules.getByRole("button", { name: "Edit", exact: true }).click();
    await rules
      .getByLabel("Instructions", { exact: true })
      .fill("Reply with LEGACY_EDITED. Do not call tools.");
    await rules
      .getByRole("button", { name: "Save trigger", exact: true })
      .click();
    await expect(
      rules.getByRole("button", { name: "Edit", exact: true }),
    ).toBeVisible();
    await page.goto(`/p/${projectId}/playground?panel=events`);
    await page
      .getByRole("button", { name: "Background triggers 1", exact: true })
      .click();
    await rules
      .getByTestId("trigger-list")
      .getByRole("button")
      .filter({ hasText: ruleName })
      .click();
    await expect(
      rules.getByRole("switch", { name: "Disabled", exact: true }),
    ).not.toBeChecked();
    await expect(
      rules.getByRole("heading", { name: "Run history", exact: true }),
    ).toBeVisible();
    await expect(rules).toContainText("No runs yet.");
    await rules
      .locator("summary")
      .filter({ hasText: /^Instructions$/ })
      .click();
    await expect(rules).toContainText("LEGACY_EDITED");
    await page.screenshot({
      path: testInfo.outputPath("events-saved-rule.png"),
    });
    page.once("dialog", (dialog) => dialog.accept());
    await rules.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible();
  }
  expect(pageErrors).toEqual([]);
});
