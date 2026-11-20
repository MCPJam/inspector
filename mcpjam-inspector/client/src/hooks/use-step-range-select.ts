import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent, MouseEvent } from "react";

export type StepRangeCopyState = "idle" | "success" | "error";

interface UseStepRangeSelectOptions<TStep> {
  /** The steps currently rendered, in flow order. */
  orderedSteps: readonly TStep[];
  /** Select mode ends on its own when this turns false (no steps, other tab). */
  available: boolean;
  /** Copies the given steps, already in flow order; resolves to success. */
  copySteps: (steps: TStep[]) => Promise<boolean>;
}

/** What the select-mode toolbar needs from the hook. */
export interface StepRangeSelectControls {
  /** There are steps to select in the current view. */
  available: boolean;
  isSelecting: boolean;
  selectedCount: number;
  copyState: StepRangeCopyState;
  enter: () => void;
  exit: () => void;
  copySelected: () => Promise<void>;
}

const COPY_FEEDBACK_MS = 2000;

/**
 * Select mode for the OAuth and XAA debugger step lists: click a step to
 * toggle it, shift-click to add every step between it and the last one
 * clicked, then copy the selection in flow order.
 */
export function useStepRangeSelect<TStep>({
  orderedSteps,
  available,
  copySteps,
}: UseStepRangeSelectOptions<TStep>) {
  const [isSelecting, setIsSelecting] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<TStep>>(new Set());
  // An anchor step rather than an index, so a step appended mid-selection
  // cannot shift the range.
  const [anchor, setAnchor] = useState<TStep | null>(null);
  const [copyState, setCopyState] = useState<StepRangeCopyState>("idle");
  const copyTimerRef = useRef<number | null>(null);

  const resetCopyState = useCallback(() => {
    if (copyTimerRef.current !== null) {
      window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = null;
    }
    setCopyState("idle");
  }, []);

  const enter = useCallback(() => {
    resetCopyState();
    setIsSelecting(true);
  }, [resetCopyState]);

  const exit = useCallback(() => {
    resetCopyState();
    setIsSelecting(false);
    setSelected(new Set());
    setAnchor(null);
  }, [resetCopyState]);

  useEffect(() => {
    if (!available && isSelecting) exit();
  }, [available, isSelecting, exit]);

  useEffect(
    () => () => {
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
    },
    [],
  );

  const toggle = (step: TStep, extendRange: boolean) => {
    const anchorIndex = anchor === null ? -1 : orderedSteps.indexOf(anchor);
    const stepIndex = orderedSteps.indexOf(step);
    setSelected((previous) => {
      const next = new Set(previous);
      if (extendRange && anchorIndex !== -1 && stepIndex !== -1) {
        const start = Math.min(anchorIndex, stepIndex);
        const end = Math.max(anchorIndex, stepIndex);
        for (const rangeStep of orderedSteps.slice(start, end + 1)) {
          next.add(rangeStep);
        }
      } else if (next.has(step)) {
        next.delete(step);
      } else {
        next.add(step);
      }
      return next;
    });
    setAnchor(step);
  };

  // Steps that dropped out of the list (e.g. after a reset) no longer count.
  const selectedSteps = orderedSteps.filter((step) => selected.has(step));

  const copySelected = async () => {
    if (selectedSteps.length === 0) return;
    resetCopyState();
    const success = await copySteps(selectedSteps);
    setCopyState(success ? "success" : "error");
    copyTimerRef.current = window.setTimeout(() => {
      setCopyState("idle");
      copyTimerRef.current = null;
    }, COPY_FEEDBACK_MS);
  };

  /**
   * Props that turn a step header into a selection checkbox while select mode
   * is on. Spread them after the header's own props; outside select mode they
   * are empty and the header keeps its expand/collapse behaviour.
   */
  const getStepHeaderProps = (step: TStep, label: string) => {
    if (!isSelecting) return {};
    return {
      role: "checkbox",
      "aria-checked": selected.has(step),
      "aria-expanded": undefined,
      "aria-label": `Select step ${label}`,
      onClick: (event: MouseEvent) => toggle(step, event.shiftKey),
      onKeyDown: (event: KeyboardEvent) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        toggle(step, event.shiftKey);
      },
    };
  };

  return {
    available,
    isSelecting,
    selectedCount: selectedSteps.length,
    copyState,
    enter,
    exit,
    isSelected: (step: TStep) => isSelecting && selected.has(step),
    copySelected,
    getStepHeaderProps,
  };
}
