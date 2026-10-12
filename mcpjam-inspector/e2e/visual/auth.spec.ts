import { expect, test } from "@playwright/test";
import { guardStagingNetwork, SYNTHETIC_ROLE } from "./staging-network";

test("staging synthetic user logs in and refreshes through the same-origin proxy", async ({
  page,
  context,
}) => {
  const email = process.env.VISUAL_TEST_EMAIL;
  const password = process.env.VISUAL_TEST_PASSWORD;
  if (!email || !password) throw new Error("Missing visual test credentials");
  const origin = "https://staging.mcpjam.com";
  const rejected: string[] = [];
  let phase = "configure network guards";
  try {
    await guardStagingNetwork(context, rejected);
    phase = "open staging login";
    await page.goto(`${origin}/login`);
    phase = "enter synthetic email";
    await page.getByRole("textbox", { name: "Email", exact: true }).fill(email);
    await page
      .getByRole("button", { name: "Continue with email", exact: true })
      .click();
    phase = "authenticate synthetic user";
    await page.getByLabel("Password", { exact: true }).fill(password);
    const authentication = page.waitForResponse(
      (response) =>
        response.url() === `${origin}/user_management/authenticate` &&
        response.ok(),
    );
    await Promise.all([
      authentication,
      page.getByRole("button", { name: "Sign in", exact: true }).click(),
    ]);
    phase = "complete synthetic profile if needed";
    const roleGate = page.getByRole("heading", {
      name: "What is your role?",
      exact: true,
    });
    const project = page.getByText("Visual Pilot v1", { exact: true }).first();
    await expect(roleGate.or(project).first()).toBeVisible({ timeout: 30_000 });
    if (await roleGate.isVisible()) {
      await page
        .getByRole("textbox", { name: "Role", exact: true })
        .fill(SYNTHETIC_ROLE);
      await page.getByRole("button", { name: "Continue", exact: true }).click();
    }
    phase = "verify synthetic project";
    await expect(
      page.getByText("Visual Pilot v1", { exact: true }).first(),
    ).toBeVisible({ timeout: 30_000 });
    phase = "reload and refresh session";
    const refresh = page.waitForResponse(
      (response) =>
        response.url() === `${origin}/user_management/authenticate` &&
        response.request().postDataJSON()?.grant_type === "refresh_token" &&
        response.ok(),
    );
    await Promise.all([refresh, page.reload()]);
    await expect(
      page.getByText("Visual Pilot v1", { exact: true }).first(),
    ).toBeVisible({ timeout: 30_000 });
    expect(rejected).toEqual([]);
  } catch {
    // Playwright call logs can contain filled credentials; report only the phase.
    const headings =
      new URL(page.url()).origin === origin
        ? await page.getByRole("heading").allTextContents()
        : [];
    throw new Error(
      `Staging authentication failed at: ${phase}. Blocked operations: ${rejected.join(", ") || "none"}. App headings: ${headings.join("; ").slice(0, 500)}`,
    );
  }
});
