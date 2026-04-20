import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { UpdateController } from "../update-controller.js";

class MockAutoUpdater extends EventEmitter {
  checkForUpdates = vi.fn();
  quitAndInstall = vi.fn();
}

function createController() {
  const updater = new MockAutoUpdater();
  const logger = {
    info: vi.fn(),
    error: vi.fn(),
  };
  const onStateChange = vi.fn();

  const controller = new UpdateController({
    updater,
    logger,
    onStateChange,
  });

  controller.start();

  return {
    controller,
    updater,
    logger,
    onStateChange,
  };
}

describe("UpdateController", () => {
  it("stores available state for late subscribers", () => {
    const { controller, updater } = createController();

    updater.emit("update-available");

    expect(controller.getState()).toEqual({
      phase: "available",
      installRequested: false,
    });
  });

  it("marks install intent during download without restarting immediately", () => {
    const { controller, updater } = createController();

    updater.emit("update-available");
    controller.requestInstall();

    expect(controller.getState()).toEqual({
      phase: "downloading",
      installRequested: true,
    });
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
  });

  it("restarts immediately when a requested update finishes downloading", () => {
    const { controller, updater } = createController();

    updater.emit("update-available");
    controller.requestInstall();
    updater.emit("update-downloaded", {}, "Big release", "2.0.0");

    expect(controller.getState()).toEqual({
      phase: "ready",
      installRequested: true,
      version: "2.0.0",
      releaseNotes: "Big release",
    });
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it("keeps the app running when download completes without prior install intent", () => {
    const { controller, updater } = createController();

    updater.emit("update-downloaded", {}, "Big release", "2.0.0");

    expect(controller.getState()).toEqual({
      phase: "ready",
      installRequested: false,
      version: "2.0.0",
      releaseNotes: "Big release",
    });
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
  });

  it("moves to retryable error state and retries checks on a later click", () => {
    const { controller, updater } = createController();

    updater.emit("update-available");
    controller.requestInstall();
    updater.emit("error", new Error("download failed"));

    expect(controller.getState()).toEqual({
      phase: "error",
      installRequested: false,
      errorMessage: "download failed",
    });

    controller.requestInstall();

    expect(controller.getState()).toEqual({
      phase: "downloading",
      installRequested: true,
    });
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
  });
});
