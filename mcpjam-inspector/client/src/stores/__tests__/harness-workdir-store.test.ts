import { beforeEach, describe, expect, it } from "vitest";
import { useHarnessWorkdirStore } from "../harness-workdir-store";

describe("harness workdir store — which machine", () => {
  beforeEach(() => {
    useHarnessWorkdirStore.setState({
      byKey: {},
      disposableByConversation: {},
    });
  });
  const state = () => useHarnessWorkdirStore.getState();

  it("records a disposable turn for its conversation, and a later personal one clears it", () => {
    state().setWorkdir("p1", "h1", "/home/user/a", "disposable", "chat-1");
    expect(state().disposableByConversation["chat-1"]).toBe(true);

    state().setWorkdir("p1", "h1", "/home/user/a", "personal", "chat-1");
    expect(state().disposableByConversation["chat-1"]).toBeUndefined();
    expect(state().byKey["h:h1"]).toBe("/home/user/a");
  });

  it("treats an absent machine as the personal computer", () => {
    state().setWorkdir("p1", "h1", "/home/user/a", "disposable", "chat-1");
    state().setWorkdir("p1", "h1", "/home/user/b", undefined, "chat-1");
    expect(state().byKey["h:h1"]).toBe("/home/user/b");
    expect(state().disposableByConversation["chat-1"]).toBeUndefined();
  });

  it("keys the machine per CONVERSATION: a compare column on the same host says nothing about the main chat", () => {
    state().setWorkdir("p1", "h1", "/home/user/main", "personal", "chat-main");
    state().setWorkdir("p1", "h1", "/home/user/col", "disposable", "chat-col");
    expect(state().disposableByConversation).toEqual({ "chat-col": true });
    // The personal-computer cwd the rail opens at is not overwritten by a path
    // from the column's own machine.
    expect(state().byKey["h:h1"]).toBe("/home/user/main");
  });

  it("keys the personal workdir per host, falling back to the project", () => {
    state().setWorkdir("p1", "h1", "/home/user/a", "personal", "c1");
    state().setWorkdir("p1", null, "/home/user/c", "personal", "c2");
    expect(state().byKey).toEqual({
      "h:h1": "/home/user/a",
      "p:p1": "/home/user/c",
    });
  });

  it("does not churn state for an identical update", () => {
    state().setWorkdir("p1", "h1", "/home/user/a", "disposable", "chat-1");
    const before = state();
    state().setWorkdir("p1", "h1", "/home/user/a", "disposable", "chat-1");
    expect(state()).toBe(before);
  });
});
