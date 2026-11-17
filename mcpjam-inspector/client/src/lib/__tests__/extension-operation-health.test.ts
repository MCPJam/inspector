import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  extensionOperationErrorCode,
  formChoice,
  observeExtensionOperation,
} from "../extension-operation-health";
import { PluginDescribedError } from "@/shared/plugin-operation";
import { PluginSettingsRequestError } from "@/shared/plugin-settings";

const track = vi.hoisted(() => vi.fn());
vi.mock("../analytics", () => ({ track }));

const outcomes = () =>
  track.mock.calls
    .filter((call) => call[0] === "extension_operation_completed")
    .map((call) => call[1]);
const secret = "customer.example/SECRET?token=TOKEN";

describe("extension operation outcomes", () => {
  beforeEach(() => track.mockClear());

  it("records one success with closed props only", async () => {
    await expect(
      observeExtensionOperation(
        { operation: "settings_save", profile: "codex" },
        async () => secret,
      ),
    ).resolves.toBe(secret);
    expect(outcomes()).toEqual([
      {
        operation: "settings_save",
        host_profile: "codex",
        outcome: "success",
        error_code: "none",
        location: "host_workspace",
      },
    ]);
  });

  it.each([
    ["decline", "declined"],
    ["cancel", "cancelled"],
  ] as const)(
    "counts a delivered %s as %s, not a failure",
    async (choice, outcome) => {
      await observeExtensionOperation(
        { operation: "form_response", choice },
        async () => undefined,
      );
      expect(outcomes()).toEqual([
        expect.objectContaining({ outcome, error_code: "none" }),
      ]);
    },
  );

  it("records a failure with a catalog code and rethrows", async () => {
    const error = new PluginDescribedError(
      secret,
      "PLUGIN_FORM_SUBMIT_TIMEOUT",
    );
    await expect(
      observeExtensionOperation(
        { operation: "form_response", choice: "submit" },
        async () => {
          throw error;
        },
      ),
    ).rejects.toBe(error);
    expect(outcomes()).toEqual([
      {
        operation: "form_response",
        host_profile: "unknown",
        outcome: "failure",
        error_code: "PLUGIN_FORM_SUBMIT_TIMEOUT",
        location: "host_workspace",
      },
    ]);
    expect(JSON.stringify(track.mock.calls)).not.toContain("SECRET");
  });

  it("counts a declined choice whose send failed as a failure", async () => {
    await expect(
      observeExtensionOperation(
        { operation: "form_response", choice: "decline" },
        async () => {
          throw new Error(secret);
        },
      ),
    ).rejects.toThrow();
    expect(outcomes()).toEqual([
      expect.objectContaining({ outcome: "failure", error_code: "other" }),
    ]);
  });

  it("counts a refused result as a failure", async () => {
    await expect(
      observeExtensionOperation(
        { operation: "app_message", profile: "chatgpt" },
        async () => false,
        (sent) => sent,
      ),
    ).resolves.toBe(false);
    expect(outcomes()).toEqual([
      expect.objectContaining({
        operation: "app_message",
        outcome: "failure",
        error_code: "refused",
      }),
    ]);
  });

  it("counts a denied approval as declined", async () => {
    await expect(
      observeExtensionOperation({ operation: "settings_save" }, async () => {
        throw new PluginSettingsRequestError("APPROVAL_DENIED", false);
      }),
    ).rejects.toThrow();
    expect(outcomes()).toEqual([
      expect.objectContaining({
        outcome: "declined",
        error_code: "APPROVAL_DENIED",
      }),
    ]);
  });

  it("records nothing when the operation is withdrawn underneath it", async () => {
    await expect(
      observeExtensionOperation({ operation: "form_response" }, async () => {
        throw new DOMException("gone", "AbortError");
      }),
    ).rejects.toThrow("gone");
    expect(outcomes()).toEqual([]);
  });

  it("keeps only catalog error codes", () => {
    expect(
      extensionOperationErrorCode(
        new PluginSettingsRequestError("SETTINGS_UNAVAILABLE", false),
      ),
    ).toBe("SETTINGS_UNAVAILABLE");
    expect(extensionOperationErrorCode({ code: secret })).toBe("other");
    expect(extensionOperationErrorCode(new Error(secret))).toBe("other");
    expect(extensionOperationErrorCode(null)).toBe("other");
  });

  it("maps form actions to the person's choice", () => {
    expect(formChoice("accept")).toBe("submit");
    expect(formChoice("decline")).toBe("decline");
    expect(formChoice("cancel")).toBe("cancel");
  });
});
