import { useLayoutEffect, useRef } from "react";

// Set by a client selector that unmounted while open, taken by the next one
// mounted in the same commit. React runs a commit's unmount cleanups and
// mount layout effects in one synchronous pass, so clearing it in a microtask
// keeps any later, unrelated mount from opening on its own.
let pendingHandoff: object | null = null;

/**
 * Keeps the client selector open when the Playground remounts it. The
 * Playground renders its composer in one subtree for a single chat and in
 * another for Compare, so the tick that starts or ends Compare unmounts the
 * selector mid-pick. Without this the new selector mounts closed and the
 * user has to reopen it to keep picking.
 */
export function useOpenAcrossRemount(isOpen: boolean, reopen: () => void) {
  const isOpenRef = useRef(isOpen);
  const reopenRef = useRef(reopen);

  useLayoutEffect(() => {
    isOpenRef.current = isOpen;
    reopenRef.current = reopen;
  });

  useLayoutEffect(() => {
    if (pendingHandoff) {
      pendingHandoff = null;
      reopenRef.current();
    }
    return () => {
      if (!isOpenRef.current) return;
      const handoff = {};
      pendingHandoff = handoff;
      queueMicrotask(() => {
        if (pendingHandoff === handoff) pendingHandoff = null;
      });
    };
  }, []);
}
