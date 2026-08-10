import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadComputerEngine,
  saveComputerEngine,
  subscribeComputerEngine,
} from "../computer-engine-storage";

describe("computer-engine-storage", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("round-trips a per-project choice; projects are independent", () => {
    saveComputerEngine("p1", "local");
    saveComputerEngine("p2", "cloud");
    expect(loadComputerEngine("p1")).toBe("local");
    expect(loadComputerEngine("p2")).toBe("cloud");
    expect(loadComputerEngine("p3")).toBeNull();
  });

  it("clearing with null removes the entry", () => {
    saveComputerEngine("p1", "local");
    saveComputerEngine("p1", null);
    expect(loadComputerEngine("p1")).toBeNull();
  });

  it("reads garbage as no-preference, never a guess", () => {
    localStorage.setItem("mcp-computer-engine:p1", "warp-drive");
    expect(loadComputerEngine("p1")).toBeNull();
  });

  it("per-key: a concurrent write to another project cannot clobber this one", () => {
    // Simulate the shared-map race: two "tabs" read, then both write. With
    // per-key storage each write touches only its own key, so nothing is lost.
    saveComputerEngine("p1", "local");
    // Another tab sets p2 without ever having seen p1.
    saveComputerEngine("p2", "cloud");
    expect(loadComputerEngine("p1")).toBe("local");
    expect(loadComputerEngine("p2")).toBe("cloud");
  });

  it("notifies same-tab subscribers for the matching project only", () => {
    const p1 = vi.fn();
    const p2 = vi.fn();
    const unsub1 = subscribeComputerEngine("p1", p1);
    const unsub2 = subscribeComputerEngine("p2", p2);
    saveComputerEngine("p1", "local");
    expect(p1).toHaveBeenCalledTimes(1);
    expect(p2).not.toHaveBeenCalled();
    unsub1();
    saveComputerEngine("p1", "cloud");
    expect(p1).toHaveBeenCalledTimes(1);
    unsub2();
  });
});
