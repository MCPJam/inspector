import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";

interface OverflowState {
  hasVerticalOverflow: boolean;
  hasHorizontalOverflow: boolean;
}

const OVERFLOW_TOLERANCE_PX = 1;
const NO_OVERFLOW: OverflowState = {
  hasVerticalOverflow: false,
  hasHorizontalOverflow: false,
};

function getOverflowState(element: HTMLElement): OverflowState {
  return {
    hasVerticalOverflow:
      element.scrollHeight > element.clientHeight + OVERFLOW_TOLERANCE_PX,
    hasHorizontalOverflow:
      element.scrollWidth > element.clientWidth + OVERFLOW_TOLERANCE_PX,
  };
}

export function useOverflowDetection<T extends HTMLElement>(
  ref: RefObject<T | null>,
  enabled = true,
): OverflowState {
  const [overflowState, setOverflowState] = useState<OverflowState>(NO_OVERFLOW);
  const frameRef = useRef<number | null>(null);

  const measureOverflow = useCallback(() => {
    if (!enabled) {
      setOverflowState((currentState) => {
        if (
          !currentState.hasVerticalOverflow &&
          !currentState.hasHorizontalOverflow
        ) {
          return currentState;
        }

        return NO_OVERFLOW;
      });
      return;
    }

    const element = ref.current;
    const nextState = element ? getOverflowState(element) : NO_OVERFLOW;

    setOverflowState((currentState) => {
      if (
        currentState.hasVerticalOverflow === nextState.hasVerticalOverflow &&
        currentState.hasHorizontalOverflow === nextState.hasHorizontalOverflow
      ) {
        return currentState;
      }

      return nextState;
    });
  }, [enabled, ref]);

  const scheduleMeasurement = useCallback(() => {
    if (typeof window === "undefined") {
      measureOverflow();
      return;
    }

    if (typeof window.requestAnimationFrame !== "function") {
      measureOverflow();
      return;
    }

    if (frameRef.current !== null) {
      window.cancelAnimationFrame(frameRef.current);
    }

    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null;
      measureOverflow();
    });
  }, [measureOverflow]);

  useLayoutEffect(() => {
    measureOverflow();
  });

  useEffect(() => {
    if (!enabled || typeof window === "undefined") {
      return;
    }

    const element = ref.current;
    if (!element) {
      return;
    }

    const handleWindowResize = () => {
      scheduleMeasurement();
    };

    let resizeObserver: ResizeObserver | undefined;
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(() => {
        scheduleMeasurement();
      });
      resizeObserver.observe(element);
    }

    let mutationObserver: MutationObserver | undefined;
    if (typeof MutationObserver !== "undefined") {
      mutationObserver = new MutationObserver(() => {
        scheduleMeasurement();
      });
      mutationObserver.observe(element, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    }

    window.addEventListener("resize", handleWindowResize);

    return () => {
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }

      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      window.removeEventListener("resize", handleWindowResize);
    };
  }, [enabled, ref, scheduleMeasurement]);

  return overflowState;
}
