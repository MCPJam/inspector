/**
 * What a sign-in page asks for. Each page a provider can show is a fixture,
 * because a misread page types a password, or approves access, where neither
 * was asked for.
 */
import { describe, expect, it } from "vitest";
import {
  isAuthKitOrigin,
  readSignInPage,
  type SignInPage,
} from "../reviewer-sign-in-pages.js";

const CALLBACK = "https://app.mcpjam.com/oauth/callback";
const AUTHKIT = { callbackUrl: CALLBACK, authKit: true, submitted: false };
const OTHER = { ...AUTHKIT, authKit: false };

const page = (
  text: string,
  controls: Array<[string, string]> = [],
  url = "https://acme.authkit.app/sign-in",
): SignInPage => ({
  url,
  text,
  controls: controls.map(([role, name], index) => ({
    ref: `e${index}`,
    role,
    name,
  })),
});

describe("readSignInPage", () => {
  it("finds the username and password fields by their names", () => {
    const seen = readSignInPage(
      page("Sign in", [
        ["textbox", "Email"],
        ["textbox", "Password"],
        ["button", "Sign in"],
      ]),
      AUTHKIT,
    );
    expect(seen).toMatchObject({
      kind: "credentials",
      username: { ref: "e0" },
      password: { ref: "e1" },
    });
  });

  it("reads a one-time password field as a verification step, not the password", () => {
    const seen = readSignInPage(
      page("Enter the code from your authenticator app", [
        ["textbox", "One-time password"],
      ]),
      { ...AUTHKIT, submitted: true },
    );
    expect(seen).toEqual({
      kind: "verification",
      quote: "Enter the code from your authenticator app",
    });
  });

  it("offers of other sign-in methods beside the form do not stop it", () => {
    const seen = readSignInPage(
      page("Sign in\nEmail me a magic link instead\nUse a passkey", [
        ["textbox", "Email"],
      ]),
      AUTHKIT,
    );
    expect(seen.kind).toBe("credentials");
  });

  it("reads a refusal only once something was submitted", () => {
    const refused = page("Incorrect email or password.\nTry again", [
      ["textbox", "Password"],
    ]);
    expect(readSignInPage(refused, AUTHKIT).kind).toBe("credentials");
    expect(readSignInPage(refused, { ...AUTHKIT, submitted: true })).toEqual({
      kind: "refused",
      quote: "Incorrect email or password",
    });
  });

  it.each([
    ["Your account has been locked."],
    ["No account found with that email"],
    ["The password you entered is incorrect"],
  ])("reads %j as refused", (text) => {
    expect(
      readSignInPage(page(text), { ...AUTHKIT, submitted: true }).kind,
    ).toBe("refused");
  });

  it.each([
    ["We sent a code to your email"],
    ["Check your inbox for a magic link"],
    ["Two-factor authentication required"],
    ["Please complete the CAPTCHA to continue"],
  ])("reads %j as a verification step", (text) => {
    expect(
      readSignInPage(page(text), { ...AUTHKIT, submitted: true }).kind,
    ).toBe("verification");
  });

  it("approves on AuthKit's consent page with its first approve control", () => {
    const seen = readSignInPage(
      page("MCPJam wants to access your account", [
        ["button", "Deny"],
        ["button", "Allow access"],
      ]),
      AUTHKIT,
    );
    expect(seen).toMatchObject({
      kind: "consent",
      approve: { name: "Allow access" },
    });
  });

  it("approves elsewhere only one approve control beside a way to refuse", () => {
    const consent = (buttons: string[]) =>
      readSignInPage(
        page(
          "Authorize MCPJam to read your workspace",
          buttons.map((name) => ["button", name]),
        ),
        OTHER,
      );
    expect(consent(["Authorize", "Cancel"])).toMatchObject({
      approve: { name: "Authorize" },
    });
    expect(consent(["Authorize"])).toEqual({
      kind: "consent",
      approve: undefined,
    });
    expect(consent(["Authorize", "Continue", "Cancel"])).toEqual({
      kind: "consent",
      approve: undefined,
    });
  });

  it("knows MCPJam's callback by origin and path, whatever the query", () => {
    const seen = readSignInPage(
      page("", [], `${CALLBACK}?code=c1&state=s1`),
      AUTHKIT,
    );
    expect(seen.kind).toBe("callback");
    expect(seen.kind === "callback" && seen.params.get("state")).toBe("s1");
    expect(
      readSignInPage(
        page("", [], "https://evil.example/oauth/callback?code=c1"),
        AUTHKIT,
      ).kind,
    ).toBe("unknown");
  });

  it("reads a page with nothing it knows as unknown", () => {
    expect(readSignInPage(page("One moment…"), AUTHKIT).kind).toBe("unknown");
  });
});

describe("isAuthKitOrigin", () => {
  it.each([
    ["https://acme.authkit.app", true],
    ["https://auth.acme.example", false],
    ["https://authkit.app.evil.example", false],
    ["not a url", false],
  ])("%s → %s", (origin, expected) => {
    expect(isAuthKitOrigin(origin)).toBe(expected);
  });
});
