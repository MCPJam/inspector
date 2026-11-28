import { useCallback, useRef, useState } from "react";

export function useAppSessionIdentity(initialSessionId: () => string) {
  const [chatSessionId, setChatSessionIdState] = useState(initialSessionId);
  // The server row changes on conflict, but the local App runtime must not.
  // Keeping its scope also retains aliases and registrations still hashing;
  // every ordinary session transition resets both identities together.
  const [appSessionScopeId, setAppSessionScopeId] = useState(chatSessionId);
  const appSessionScopeIdRef = useRef(appSessionScopeId);
  appSessionScopeIdRef.current = appSessionScopeId;
  // Only a conflict continuation keeps the previous row as its App owner.
  const appLifetimeRevisionRef = useRef(0);
  const setChatSessionId = useCallback((id: string, appScopeId?: string) => {
    if (appScopeId === undefined || appScopeId !== appSessionScopeIdRef.current) {
      appLifetimeRevisionRef.current += 1;
    }
    setAppSessionScopeId(appScopeId ?? id);
    setChatSessionIdState(id);
  }, []);
  // Reopening the same row can create a new App with the same scope ID.
  const captureContextRestore = useCallback((restore?: () => void) => {
    const revision = appLifetimeRevisionRef.current;
    return () => {
      if (appLifetimeRevisionRef.current === revision) restore?.();
    };
  }, []);
  return {
    chatSessionId,
    setChatSessionId,
    appSessionScopeId,
    appSessionScopeIdRef,
    captureContextRestore,
  };
}
