import { describe, expect, it, vi } from "vitest";
import { NativeSettingsController } from "../native-settings-controller";
import { settingsFixture } from "../../../../../shared/__tests__/plugin-settings-fixture";
import { PluginSettingsRequestError } from "@/shared/plugin-settings";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function setup() {
  const read = vi.fn().mockResolvedValue(settingsFixture());
  const update = vi.fn().mockImplementation(async ({ set }) => ({
    values: { ...settingsFixture().values, ...set },
  }));
  return {
    controller: new NativeSettingsController(settingsFixture(), {
      read,
      update,
    }),
    read,
    update,
  };
}

describe("native settings save lifetime", () => {
  it("retains edits after an authoritative pre-dispatch refusal without requiring refresh", async () => {
    const { controller, update } = setup();
    controller.edit("count", "3");
    update.mockRejectedValueOnce(
      new PluginSettingsRequestError("APPROVAL_DENIED", false),
    );
    await expect(controller.save()).rejects.toThrow("APPROVAL_DENIED");
    expect(controller.getSnapshot()).toMatchObject({
      uncertain: false,
      dirty: true,
      error: "APPROVAL_DENIED",
    });
    await controller.save();
    expect(controller.getSnapshot()).toMatchObject({
      uncertain: false,
      dirty: false,
      draft: { count: 3 },
    });
  });
  it.each(["0x10", "Infinity", "NaN", " "])(
    "rejects non-decimal numeric edit %s before dispatch",
    async (value) => {
      const { controller, update } = setup();
      controller.edit("count", value);
      await expect(controller.save()).rejects.toThrow(
        "PLUGIN_SETTINGS_INVALID_EDIT",
      );
      expect(update).not.toHaveBeenCalled();
    },
  );
  it("sends only changed keys and converts editor numbers without coercing server values", async () => {
    const { controller, update } = setup();
    controller.edit("rate", "0.30");
    await controller.save();
    expect(update).not.toHaveBeenCalled();
    controller.edit("count", "3");
    controller.edit("label", "new");
    await controller.save();
    expect(update.mock.calls[0][0]).toEqual({
      set: { count: 3, label: "new" },
    });
    expect(controller.getSnapshot()).toMatchObject({
      dirty: false,
      busy: null,
    });
  });
  it("takes returned effective values as the baseline, including server normalization", async () => {
    const { controller, update } = setup();
    update.mockResolvedValue({
      values: { ...settingsFixture().values, label: "NORMALIZED", count: 9 },
    });
    controller.edit("label", "normalized");
    await controller.save();
    expect(controller.getSnapshot().draft).toMatchObject({
      label: "NORMALIZED",
      count: 9,
    });
    expect(controller.getSnapshot().dirty).toBe(false);
    expect(update).toHaveBeenCalledTimes(1);
  });
  it("shares concurrent saves, preserves newer edits and coalesces a second diff", async () => {
    const { controller, update } = setup();
    const first = deferred<unknown>();
    update.mockReturnValueOnce(first.promise);
    controller.edit("label", "first");
    const saving = controller.save();
    expect(controller.save()).toBe(saving);
    await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    controller.edit("label", "newest");
    controller.edit("count", "4");
    first.resolve({
      values: { ...settingsFixture().values, label: "first", rate: 0.4 },
    });
    update.mockResolvedValueOnce({
      values: {
        ...settingsFixture().values,
        label: "newest",
        count: 4,
        rate: 0.4,
      },
    });
    await saving;
    expect(update.mock.calls[1][0]).toEqual({
      set: { label: "newest", count: 4 },
    });
    expect(controller.getSnapshot()).toMatchObject({
      dirty: false,
      draft: { label: "newest", count: 4, rate: 0.4 },
    });
  });
  it("refuses invalid edits before dispatch and retains them visibly", async () => {
    const { controller, update } = setup();
    controller.edit("rate", "");
    controller.edit("enabled", "false");
    await expect(controller.save()).rejects.toThrow(
      "PLUGIN_SETTINGS_INVALID_EDIT",
    );
    expect(update).not.toHaveBeenCalled();
    expect(controller.getSnapshot()).toMatchObject({
      dirty: true,
      draft: { rate: "" },
      errors: { rate: expect.any(String), enabled: expect.any(String) },
    });
  });
  it("retains newer edits during refresh and adopts new effective values elsewhere", async () => {
    const { controller, read } = setup();
    const pending = deferred<unknown>();
    read.mockReturnValue(pending.promise);
    controller.edit("label", "unsaved");
    const refresh = controller.refresh();
    controller.edit("count", "7");
    pending.resolve({
      ...settingsFixture(),
      values: {
        ...settingsFixture().values,
        label: "remote",
        count: 5,
        theme: "dark",
      },
    });
    await refresh;
    expect(controller.getSnapshot()).toMatchObject({
      draft: { label: "unsaved", count: "7", theme: "dark" },
      dirty: true,
    });
  });
  it.each(["lost ack", "invalid result"])(
    "fences %s until a successful refresh without automatic write retry",
    async (failure) => {
      const { controller, update } = setup();
      if (failure === "lost ack")
        update.mockRejectedValue(new Error("lost acknowledgement"));
      else update.mockResolvedValue({ values: { count: 3 } });
      controller.edit("count", "3");
      await expect(controller.save()).rejects.toThrow();
      expect(controller.getSnapshot()).toMatchObject({
        dirty: true,
        uncertain: true,
        draft: { count: "3" },
      });
      expect(controller.getSnapshot().document.values.count).toBe(2);
      await expect(controller.save()).rejects.toThrow(
        "PLUGIN_SETTINGS_REFRESH_REQUIRED",
      );
      expect(update).toHaveBeenCalledTimes(1);
      await controller.refresh();
      expect(controller.getSnapshot().uncertain).toBe(false);
    },
  );
  it("rejects schema changes during refresh and fences stale writes without losing edits", async () => {
    const { controller, read, update } = setup();
    const changed = settingsFixture();
    changed.schema.properties.count.minimum = 1;
    read.mockResolvedValue(changed);
    controller.edit("label", "unsaved");
    await expect(controller.refresh()).rejects.toThrow(
      "PLUGIN_SETTINGS_SCHEMA_CHANGED",
    );
    expect(controller.getSnapshot()).toMatchObject({
      invalidated: true,
      draft: { label: "unsaved" },
    });
    await expect(controller.save()).rejects.toThrow("PLUGIN_SETTINGS_CLOSED");
    expect(update).not.toHaveBeenCalled();
  });
  it("aborts ownership and withholds a late acknowledgement after close", async () => {
    const { controller, update } = setup();
    const pending = deferred<unknown>();
    update.mockReturnValue(pending.promise);
    controller.edit("count", "3");
    const saving = controller.save();
    await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    controller.close();
    expect(update.mock.calls[0][1].aborted).toBe(true);
    pending.resolve({ values: { ...settingsFixture().values, count: 3 } });
    await expect(saving).rejects.toThrow();
    expect(controller.getSnapshot()).toMatchObject({
      closed: true,
      document: { values: { count: 2 } },
    });
  });
  it("rejects unknown fields and isolates snapshots from caller mutation", () => {
    const { controller } = setup();
    expect(() => controller.edit("foreign", true)).toThrow(
      "PLUGIN_SETTINGS_UNKNOWN_FIELD",
    );
    controller.getSnapshot().document.values.count = 100;
    controller.edit("label", "next");
    expect(controller.getSnapshot().document.values.count).toBe(2);
  });
});
