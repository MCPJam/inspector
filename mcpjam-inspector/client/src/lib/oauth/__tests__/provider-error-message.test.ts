import { describe, expect, it } from "vitest";
import {
  providerErrorMessage,
  UNVERIFIED_PROVIDER_ERROR_MESSAGE,
} from "../provider-error-message";

const denied = {
  error: "access_denied",
  errorDescription: "The user denied access",
};
const issuer = "https://auth.example.com";

describe("providerErrorMessage", () => {
  it("shows the provider's text once iss matches the recorded issuer", () => {
    expect(
      providerErrorMessage({ ...denied, iss: issuer }, { recordedIssuer: issuer }),
    ).toBe("The user denied access");
  });

  it("hides the provider's text when iss doesn't match", () => {
    expect(
      providerErrorMessage(
        { ...denied, iss: "https://evil.example" },
        { recordedIssuer: issuer },
      ),
    ).toBe(UNVERIFIED_PROVIDER_ERROR_MESSAGE);
  });

  it("hides it when iss support was advertised but iss is missing", () => {
    expect(
      providerErrorMessage(denied, {
        recordedIssuer: issuer,
        issParameterSupported: true,
      }),
    ).toBe(UNVERIFIED_PROVIDER_ERROR_MESSAGE);
  });

  it("hides it when no issuer was recorded to check against", () => {
    expect(providerErrorMessage({ ...denied, iss: issuer }, {})).toBe(
      UNVERIFIED_PROVIDER_ERROR_MESSAGE,
    );
  });
});
