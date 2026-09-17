import { test, expect } from "@playwright/test";
test("execution, grading, observations and partial chains remain distinct in the browser", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(
    page.getByText("Execution: Broke", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Goal result: Passed", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Run decision: Inconclusive", { exact: true }),
  ).toBeVisible();
  for (const [button, result] of [
    ["Goal failed", "Failed"],
    ["Grading", "Grading"],
    ["Could not grade", "Inconclusive"],
    ["Not graded", "Not graded"],
    ["Recovered tool error", "Passed"],
  ]) {
    await page.getByRole("button", { name: button, exact: true }).click();
    await expect(
      page.getByText(`Goal result: ${result}`, { exact: true }),
    ).toBeVisible();
  }
  await expect(page.getByText(/No tool errors.*1 findings/)).toBeVisible();
  await expect(
    page.getByText("Run decision: Passed", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("swarm-reporting.png"),
    fullPage: true,
  });
  expect(errors).toEqual([]);
});
