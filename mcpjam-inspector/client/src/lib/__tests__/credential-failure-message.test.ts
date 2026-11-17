import { describe, expect, it } from "vitest";
import { credentialFailureMessage } from "../credential-refusal";

describe("run credential failure messages", () => {
  it("does not promote raw transport errors", () => {
    expect(
      credentialFailureMessage({ error: "Streamable HTTP error: 502" }),
    ).toBeUndefined();
  });
  it.each([
    { uploadedAccount: true },
    { exportDenied: true },
    { credentialRefusal: "insecure_transport" },
  ])("promotes a tagged credential failure", (details) => {
    expect(
      credentialFailureMessage({ error: "Use a fresh token.", ...details }),
    ).toBe("Use a fresh token.");
  });
});
