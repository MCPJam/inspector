import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NativeSettingsEditor } from "../NativeSettingsEditor";
import { NativeSettingsController } from "../native-settings-controller";
import { settingsFixture } from "../../../../../shared/__tests__/plugin-settings-fixture";
import { PluginSettingsRequestError } from "@/shared/plugin-settings";

const track = vi.hoisted(() => vi.fn());
vi.mock("@/lib/analytics", () => ({ track }));

const outcomes = () =>
  track.mock.calls
    .filter((call) => call[0] === "extension_operation_completed")
    .map((call) => call[1]);

async function save(update: () => Promise<unknown>) {
  const controller = new NativeSettingsController(settingsFixture(), {
    read: vi.fn(),
    update,
  });
  render(<NativeSettingsEditor controller={controller} profile="chatgpt" />);
  act(() => controller.edit("count", "PRIVATE_VALUE".length));
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
  });
}

describe("Settings save outcome", () => {
  beforeEach(() => track.mockClear());
  afterEach(cleanup);

  it("records one success per save", async () => {
    await save(async () => ({
      values: { ...settingsFixture().values, count: 13 },
    }));
    expect(outcomes()).toEqual([
      {
        operation: "settings_save",
        host_profile: "chatgpt",
        outcome: "success",
        error_code: "none",
        location: "host_workspace",
      },
    ]);
  });

  it("records one failure with the refusal code and no values", async () => {
    await save(async () => {
      throw new PluginSettingsRequestError("SETTINGS_UNAVAILABLE", false);
    });
    expect(outcomes()).toEqual([
      expect.objectContaining({
        outcome: "failure",
        error_code: "SETTINGS_UNAVAILABLE",
      }),
    ]);
    expect(JSON.stringify(track.mock.calls)).not.toMatch(/13|PRIVATE/);
  });
});
