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
    localStorage.setItem("mcp-computer-engine", '"local"');
    expect(loadComputerEngine("p1")).toBeNull();
    localStorage.setItem(
      "mcp-computer-engine",
      JSON.stringify({ p1: "warp-drive" }),
    );
    expect(loadComputerEngine("p1")).toBeNull();
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
