import { describe, expect, it } from "vitest";
import {
  EXTERNAL_ACCOUNT_CREDENTIALS,
  externalAccountCredentialFor,
} from "../external-credential-selection";

describe("externalAccountCredentialFor", () => {
  it("knows Cursor's credential and nobody else's", () => {
    expect(externalAccountCredentialFor("cursor")?.env).toBe("CURSOR_API_KEY");
    for (const id of [
      "claude-code",
      "codex",
      "",
      undefined,
      null,
      "toString",
    ]) {
      expect(externalAccountCredentialFor(id as never)).toBeUndefined();
    }
  });

  it("says where egress injects the organization's key", () => {
    expect(EXTERNAL_ACCOUNT_CREDENTIALS.cursor.binding).toEqual({
      hosts: ["api2.cursor.sh"],
      header: "authorization",
      template: "Bearer {}",
    });
  });
});
