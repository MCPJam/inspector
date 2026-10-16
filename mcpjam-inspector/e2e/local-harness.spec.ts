import { test, expect, type APIRequestContext } from "@playwright/test";
const api = "http://127.0.0.1:6315";
async function stats(request: APIRequestContext) {
  return (await request.get(`${api}/stats`)).json();
}
for (const harness of ["claude-code", "codex"]) {
  test.describe(harness, () => {
    test.beforeEach(async ({ request }) => {
      await request.post(`${api}/reset`, { data: { harness, count: 2 } });
    });
    test("two approvals execute once each and duplicate replay is refused", async ({
      page,
      request,
    }) => {
      let replay: string | null = null;
      page.on("request", (req) => {
        if (req.url().endsWith("/api/chat")) replay = req.postData();
      });
      await page.goto("/");
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await page.getByRole("button", { name: "Approve", exact: true }).click();
      await expect.poll(() => stats(request)).toMatchObject({ executions: 1 });
      await page.getByRole("button", { name: "Approve", exact: true }).click();
      await expect
        .poll(() => stats(request))
        .toMatchObject({ executions: 2, resumed: 2 });
      expect(replay).not.toBeNull();
      const duplicate = await request.post(`${api}/chat`, {
        data: replay!,
        headers: { "Content-Type": "application/json" },
      });
      const refusal = await duplicate.text();
      expect(refusal).toContain('"type":"error"');
      expect(refusal).toContain("local session holding this approval has ended");
      expect(await stats(request)).toMatchObject({ executions: 2, resumed: 2 });
      await expect(
        page.getByRole("button", { name: "Approve", exact: true }),
      ).toHaveCount(0);
    });
    test("denial does not execute the command", async ({ page, request }) => {
      await request.post(`${api}/reset`, { data: { harness, count: 1 } });
      await page.goto("/");
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await page.getByRole("button", { name: "Deny", exact: true }).click();
      await expect
        .poll(() => stats(request))
        .toMatchObject({ executions: 0, resumed: 1 });
      await expect(
        page.getByRole("button", { name: "Approve", exact: true }),
      ).toHaveCount(0);
    });
    test("reload restores the pending approval", async ({ page, request }) => {
      await request.post(`${api}/reset`, { data: { harness, count: 1 } });
      await page.goto("/");
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await expect(
        page.getByRole("button", { name: "Approve", exact: true }),
      ).toBeVisible();
      await expect
        .poll(async () => (await request.get(`${api}/history`)).json())
        .toHaveProperty("pending.0.approvalId", "a1");
      await page.reload();
      await page.getByRole("button", { name: "Approve", exact: true }).click();
      await expect
        .poll(() => stats(request))
        .toMatchObject({ executions: 1, resumed: 1 });
    });
    test("Stop clears the pending runtime", async ({ page, request }) => {
      await page.goto("/");
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await expect(
        page.getByRole("button", { name: "Approve", exact: true }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Stop", exact: true }).click();
      await expect
        .poll(() => stats(request))
        .toMatchObject({ executions: 0, active: 0 });
      await expect(
        page.getByRole("button", { name: "Approve", exact: true }),
      ).toHaveCount(0);
    });
  });
}
