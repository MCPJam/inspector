/**
 * Reading a vendor's own JSON: a sign-in or error page in its place fails as
 * the driver's typed failure, and the page's text stays out of the message.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { PageDriverError, pollUntil, type PageDriver } from "../page-driver";
import { claudeWebPageModule } from "../claude-web";
import { leadingJsonString, readVendorJson } from "../vendor-json";

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

/** The hosted browser's text read stops at 16,000 bytes. */
const TEXT_CAP = 16_000;

describe("a vendor answer past the hosted browser's text cap", () => {
  const memberships = Array.from({ length: 1_000 }, (_, i) => ({ uuid: `org-${i}`, name: `Team ${i}` }));
  const account = JSON.stringify({ uuid: "acct", email_address: "seat@example.com", memberships });
  const shown = account.slice(0, TEXT_CAP);

  it("can't be parsed whole, but its leading field still reads", () => {
    expect(account.length).toBeGreaterThan(TEXT_CAP);
    expect(leadingJsonString(shown, "email_address")).toBe("seat@example.com");
    expect(leadingJsonString('{"email_address":"a\\"b@example.com"}', "email_address")).toBe('a"b@example.com');
    expect(leadingJsonString("<title>Log in</title>", "email_address")).toBeUndefined();
  });

  it("lets Claude's sign-in check name the account on the hosted browser", async () => {
    let at = "https://claude.ai/new";
    const driver: PageDriver = {
      ...pageAnswering("", false),
      async navigate(next) {
        at = next;
      },
      async url() {
        return at;
      },
      async readText(selector) {
        return selector === '[data-testid="chat-input"]' ? "" : undefined;
      },
      async pageText() {
        // The organization list is past the cap too: the account still reads.
        return at.endsWith("/api/organizations") ? `[{"uuid":"org-1","name":"Te` : shown;
      },
    };
    const failure = await readVendorJson(driver, "https://claude.ai/api/account").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PageDriverError);
    await expect(claudeWebPageModule.signedIn(driver, { timeoutMs: 1_000 })).resolves.toMatchObject({
      email: "seat@example.com",
    });
  });
});

it("keeps a hosted failure other than a cut-off answer, rather than save without a workspace", async () => {
  let at = "https://claude.ai/new";
  const driver: PageDriver = {
    ...pageAnswering("", false),
    async navigate(next) {
      if (next.endsWith("/api/organizations")) throw new PageDriverError("failed", "The page didn't open.");
      at = next;
    },
    async url() {
      return at;
    },
    async readText(selector) {
      return selector === '[data-testid="chat-input"]' ? "" : undefined;
    },
    async pageText() {
      return '{"email_address":"seat@example.com"}';
    },
  };
  await expect(claudeWebPageModule.signedIn(driver, { timeoutMs: 1_000 })).rejects.toThrow("didn't open");
});
