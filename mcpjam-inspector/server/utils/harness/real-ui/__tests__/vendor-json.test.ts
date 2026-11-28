/**
 * Reading a vendor's own JSON: a sign-in or error page in its place fails as
 * the driver's typed failure, and the page's text stays out of the message.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { PageDriverError, pollUntil, type PageDriver } from "../page-driver";
import { readVendorJson } from "../vendor-json";

const SIGN_IN_PAGE =
  "<!doctype html><title>Log in</title><p>Continue as seat@example.com</p>";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A page whose own fetch and whose shown text both answer with `body`. */
function pageAnswering(body: string, canEvaluate: boolean): PageDriver {
  vi.stubGlobal("fetch", async () => new Response(body, { status: 200 }));
  let url = "https://vendor.example/new";
  return {
    kind: canEvaluate ? "playwright" : "hosted",
    canEvaluate,
    playwrightSelectors: canEvaluate,
    async navigate(next) {
      url = next;
    },
    async url() {
      return url;
    },
    async evaluate(fn, arg) {
      return fn(arg);
    },
    waitFor: pollUntil,
    click: vi.fn(async () => undefined),
    type: vi.fn(async () => undefined),
    press: vi.fn(async () => undefined),
    async readText() {
      return body;
    },
  };
}

describe("readVendorJson", () => {
  it.each([
    ["a script in the page", true],
    ["the page the browser shows", false],
  ])(
    "fails as the driver when %s gets a page instead of JSON, without its text",
    async (_from, canEvaluate) => {
      const failure = await readVendorJson(
        pageAnswering(SIGN_IN_PAGE, canEvaluate),
        "https://vendor.example/api/me",
      ).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(PageDriverError);
      expect(failure).toMatchObject({ code: "failed" });
      expect((failure as Error).message).not.toMatch(/seat@example|Log in/);
    },
  );

  it("reads the JSON the site answers with", async () => {
    await expect(
      readVendorJson(
        pageAnswering('{"email":"seat@example.com"}', true),
        "https://vendor.example/api/me",
      ),
    ).resolves.toEqual({ email: "seat@example.com" });
  });
});
