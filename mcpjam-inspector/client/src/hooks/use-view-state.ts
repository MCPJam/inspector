import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  DEFAULT_PLAYGROUND_PAYLOAD,
  type PlaygroundViewPayloadV1,
} from "@/shared/playground-view";

export interface ViewStateValue {
  /** Currently displayed (possibly edited) payload. */
  payload: PlaygroundViewPayloadV1;
  /** Last-saved baseline. Equal to `payload` when not dirty. */
  saved: PlaygroundViewPayloadV1;
  /** True when `payload` diverges from `saved`. */
  isDirty: boolean;
  setPayload: (
    next:
      | PlaygroundViewPayloadV1
      | ((current: PlaygroundViewPayloadV1) => PlaygroundViewPayloadV1),
  ) => void;
  /** Mark the current payload as saved (clears dirty state). */
  markSaved: () => void;
  /** Reset both payload and saved baseline to a new value. */
  reset: (next: PlaygroundViewPayloadV1) => void;
}

const ViewStateContext = createContext<ViewStateValue | null>(null);

/**
 * Phase 2 scaffold + Phase 4 context boundary. In-memory only here; Phase 5
 * swaps the implementation to load/save Convex `playgroundViews` via
 * `useQuery` / `useMutation` without changing the consumer API.
 */
export function useViewState(
  initial: PlaygroundViewPayloadV1 = DEFAULT_PLAYGROUND_PAYLOAD,
): ViewStateValue {
  const initialRef = useRef(initial);
  const [payload, setPayloadState] = useState<PlaygroundViewPayloadV1>(
    initialRef.current,
  );
  const [saved, setSaved] = useState<PlaygroundViewPayloadV1>(
    initialRef.current,
  );

  const setPayload = useCallback<ViewStateValue["setPayload"]>((next) => {
    setPayloadState((current) =>
      typeof next === "function"
        ? (next as (c: PlaygroundViewPayloadV1) => PlaygroundViewPayloadV1)(
            current,
          )
        : next,
    );
  }, []);

  const markSaved = useCallback(() => {
    setSaved(payload);
  }, [payload]);

  const reset = useCallback((next: PlaygroundViewPayloadV1) => {
    setPayloadState(next);
    setSaved(next);
  }, []);

  const isDirty = useMemo(
    () => !payloadEqual(payload, saved),
    [payload, saved],
  );

  return { payload, saved, isDirty, setPayload, markSaved, reset };
}

export function ViewStateProvider({
  value,
  children,
}: {
  value: ViewStateValue;
  children: ReactNode;
}) {
  return createElement(ViewStateContext.Provider, { value }, children);
}

export function useViewStateContext(): ViewStateValue {
  const ctx = useContext(ViewStateContext);
  if (!ctx) {
    throw new Error("useViewStateContext must be used inside a ViewStateProvider");
  }
  return ctx;
}

/**
 * Deep-enough equality for the v1 payload shape. JSON stringify is intentional
 * — the payload is JSON-serializable by construction (Convex `v.any()` blob),
 * and reference equality wouldn't catch in-place mutations.
 */
function payloadEqual(
  a: PlaygroundViewPayloadV1,
  b: PlaygroundViewPayloadV1,
): boolean {
  if (a === b) return true;
  return JSON.stringify(a) === JSON.stringify(b);
}
