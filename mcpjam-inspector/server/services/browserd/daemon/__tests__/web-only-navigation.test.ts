/**
 * A public-only browser opens http(s) pages only: a `file:` or `chrome:` page
 * never passes through the egress proxy, so the driver refuses it itself.
 */
import { describe, expect, it } from "vitest";
import type { BrowserCommand } from "../../protocol";
import { ChromiumDriver } from "../chromium-driver";
import { fakeContext, fakePage } from "./fake-page";

const navigate = (url: string): BrowserCommand => ({
  commandId: `c-${url}`,
  source: "chat",
  action: { kind: "navigate", url },
});

describe("a web-only driver", () => {
  it("refuses a page that is not http(s), and opens one that is", async () => {
    const page = fakePage();
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context, { webOnly: true });
    for (const url of [
      "file:///etc/passwd",
      "chrome://settings",
      "javascript:alert(1)",
    ]) {
      const result = await driver.execute(navigate(url));
      expect(result).toMatchObject({
        ok: false,
        error: expect.stringMatching(/^browser_policy_refused/),
      });
    }
    expect(page.calls.goto).toEqual([]);
    expect(
      (await driver.execute(navigate("https://auth.example.com/"))).ok,
    ).toBe(true);
    expect(page.calls.goto).toEqual(["https://auth.example.com/"]);
  });

  it("is off unless the boot asks for it", async () => {
    const page = fakePage();
    const { context } = fakeContext({ pages: [page] });
    const driver = new ChromiumDriver(context);
    await driver.execute(navigate("file:///tmp/report.html"));
    expect(page.calls.goto).toEqual(["file:///tmp/report.html"]);
  });
});
