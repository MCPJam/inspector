import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClientCspToastGroup } from "../client-csp-toast";

describe("grouped client CSP toast", () => {
  const image = {
    capability: "cspResourceDomains.image",
    directive: "img-src",
    rule: "img-src data: blob:",
  };
  const font = {
    capability: "cspResourceDomains.font",
    directive: "font-src",
    rule: "font-src data: blob:",
  };
  let show: ReturnType<typeof vi.fn>;
  let dismiss: ReturnType<typeof vi.fn>;
  let group: ClientCspToastGroup;
  beforeEach(() => {
    vi.useFakeTimers();
    show = vi.fn();
    dismiss = vi.fn();
    group = new ClientCspToastGroup(show, dismiss);
    group.activate("app", "proxy:1");
  });
  afterEach(() => {
    group.dispose();
    vi.useRealTimers();
  });

  it("groups the first burst, then updates the same toast for another capability", () => {
    group.report("app", "proxy:1", "Goose", [image]);
    vi.advanceTimersByTime(200);
    group.report("app", "proxy:1", "Goose", [font, image]);
    expect(show).not.toHaveBeenCalled();
    vi.advanceTimersByTime(50);
    expect(show).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenLastCalledWith(expect.any(String), "Goose", [
      image,
      font,
    ]);
    const id = show.mock.calls[0][0];
    group.report("app", "proxy:1", "Goose", [
      { ...font, capability: "cspResourceDomains.media" },
    ]);
    vi.advanceTimersByTime(250);
    expect(show).toHaveBeenCalledTimes(2);
    expect(show.mock.calls[1][0]).toBe(id);
  });

  it.each(["expired", "dismissed"])(
    "does not reopen a %s toast for repeated blocks",
    (state) => {
      group.report("app", "proxy:1", "Goose", [image]);
      vi.advanceTimersByTime(250);
      if (state === "dismissed") dismiss(show.mock.calls[0][0]);
      else vi.advanceTimersByTime(10000);
      group.report("app", "proxy:1", "Goose", [image]);
      vi.advanceTimersByTime(1000);
      expect(show).toHaveBeenCalledTimes(1);
    },
  );

  it("cancels old pending notifications and ignores stale mount events", () => {
    group.report("app", "proxy:1", "Goose", [image]);
    group.activate("app", "proxy:2");
    expect(group.isStale("app", "proxy:1")).toBe(true);
    group.report("app", "proxy:1", "Goose", [font]);
    vi.advanceTimersByTime(250);
    expect(show).not.toHaveBeenCalled();
    group.report("app", "proxy:2", "New client", [font]);
    vi.advanceTimersByTime(250);
    expect(show).toHaveBeenLastCalledWith(expect.any(String), "New client", [
      font,
    ]);
  });

  it("clears on reload and unmount, without clearing other apps", () => {
    group.activate("other", "other:1");
    group.report("app", "proxy:1", "Goose", [image]);
    group.report("other", "other:1", "Other client", [font]);
    group.clearToolCall("app");
    vi.advanceTimersByTime(250);
    expect(show).toHaveBeenCalledTimes(1);
    expect(show.mock.calls[0][1]).toBe("Other client");
    group.dispose();
    expect(dismiss).toHaveBeenCalledWith(show.mock.calls[0][0]);
  });

  it("keeps inline and modal mounts separate", () => {
    group.activate("app", "modal:1", "modal");
    expect(group.isStale("app", "proxy:1")).toBe(false);
    expect(group.isStale("app", "modal:1")).toBe(false);
  });
});
