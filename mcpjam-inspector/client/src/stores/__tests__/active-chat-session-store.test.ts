import { afterEach, expect, it } from "vitest";
import { useActiveChatSessionStore } from "../active-chat-session-store";
afterEach(() => useActiveChatSessionStore.setState({ sessionId: null, restoredSession: null, browserLocation: null, browserSessionId: null }));
it("keeps restored metadata on the same conversation and clears it for new chat", () => {
  const store = useActiveChatSessionStore.getState();
  store.setRestoredSession({ sessionId: "wire", origin: "api", browser: { browserSessionId: "logical", state: "sleeping" } });
  store.setSessionId("wire");
  expect(useActiveChatSessionStore.getState().restoredSession?.origin).toBe("api");
  store.setSessionId("new-wire");
  expect(useActiveChatSessionStore.getState().restoredSession).toBeNull();
});
