import { afterEach, expect, it } from "vitest";
import { useActiveChatSessionStore } from "../active-chat-session-store";
afterEach(() => useActiveChatSessionStore.setState({ sessionId: null, restoredSession: null, browserLocation: null, browserSessionId: null, approvalSettings: {}, restorationPending: false }));
it("keeps restored metadata on the same conversation and clears it for new chat", () => {
  const store = useActiveChatSessionStore.getState();
  store.setRestoredSession({ sessionId: "wire", origin: "api", browser: { browserSessionId: "logical", state: "sleeping" } });
  store.setSessionId("wire");
  expect(useActiveChatSessionStore.getState().restoredSession?.origin).toBe("api");
  store.setSessionId("new-wire");
  expect(useActiveChatSessionStore.getState().restoredSession).toBeNull();
});

it("keeps conversation approval settings while restoring browser metadata", () => {
  const store = useActiveChatSessionStore.getState();
  store.setApprovalSetting("wire", true);
  store.setRestorationPending(true);
  store.setRestoredSession({ sessionId: "wire", origin: "api", browser: { browserSessionId: "logical", state: "active" } });
  expect(useActiveChatSessionStore.getState()).toMatchObject({
    approvalSettings: { wire: true }, restorationPending: true,
    restoredSession: { origin: "api", browser: { browserSessionId: "logical" } },
  });
  store.setSessionId("next");
  expect(useActiveChatSessionStore.getState().approvalSettings.wire).toBe(true);
  expect(useActiveChatSessionStore.getState().restoredSession).toBeNull();
});
