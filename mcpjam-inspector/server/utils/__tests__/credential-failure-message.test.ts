import { describe, expect, it } from "vitest";
import { credentialFailureMessage, ErrorCode, WebRouteError } from "../../routes/web/errors.js";

describe("credential setup failure messages", () => {
  it("preserves an uploaded-account instruction through cause wrappers", () => {
    const failure = new WebRouteError(401, ErrorCode.UNAUTHORIZED, "Upload a fresh token.", { uploadedAccount: true });
    expect(credentialFailureMessage(new Error("Setup failed", { cause: failure }))).toBe("Upload a fresh token.");
  });
  it("preserves a policy refusal", () => {
    const failure = new WebRouteError(403, ErrorCode.FORBIDDEN, "Ask a project admin to allow local runs.", { credentialRefusal: "export_denied" });
    expect(credentialFailureMessage(failure)).toBe(failure.message);
  });
  it("does not promote an unclassified upstream error", () => {
    expect(credentialFailureMessage(new Error("arbitrary upstream content"))).toBeUndefined();
  });
});
