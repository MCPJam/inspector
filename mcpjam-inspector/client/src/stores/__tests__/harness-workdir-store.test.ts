import { beforeEach, describe, expect, it } from "vitest";
import { useHarnessWorkdirStore } from "../harness-workdir-store";

describe("harness workdir store — which machine", () => {
  beforeEach(() => {
    useHarnessWorkdirStore.setState({ byKey: {}, disposableByKey: {} });
  });
  const state = () => useHarnessWorkdirStore.getState();

  it("records a disposable turn, and a later personal one clears it", () => {
    state().setWorkdir("p1", "h1", "/home/user/a", "disposable");
    expect(state().byKey["h:h1"]).toBe("/home/user/a");
    expect(state().disposableByKey["h:h1"]).toBe(true);

    state().setWorkdir("p1", "h1", "/home/user/a", "personal");
    expect(state().disposableByKey["h:h1"]).toBeUndefined();
  });

  it("treats an absent machine as the personal computer", () => {
    state().setWorkdir("p1", "h1", "/home/user/a", "disposable");
    state().setWorkdir("p1", "h1", "/home/user/b");
    expect(state().byKey["h:h1"]).toBe("/home/user/b");
    expect(state().disposableByKey["h:h1"]).toBeUndefined();
  });

  it("keys the machine like the workdir: per host, falling back to the project", () => {
    state().setWorkdir("p1", "h1", "/home/user/a", "disposable");
    state().setWorkdir("p1", "h2", "/home/user/b", "personal");
    state().setWorkdir("p1", null, "/home/user/c", "disposable");
    expect(state().disposableByKey).toEqual({ "h:h1": true, "p:p1": true });
  });

  it("does not churn state for an identical update", () => {
    state().setWorkdir("p1", "h1", "/home/user/a", "disposable");
    const before = state();
    state().setWorkdir("p1", "h1", "/home/user/a", "disposable");
    expect(state()).toBe(before);
  });
});
