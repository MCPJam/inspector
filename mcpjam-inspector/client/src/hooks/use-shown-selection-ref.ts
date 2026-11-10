import { useRef } from "react";
import {
  withoutTaskAnswersCheck,
  type ConformanceSelection,
} from "@/shared/conformance-settings";
import { useTasksUpdateCheckEnabled } from "@/components/conformance/conformance-catalogs";

/** A run's picks, read when it starts, minus checks this user can't see. */
export function useShownSelectionRef(selection?: ConformanceSelection) {
  const updateCheck = useTasksUpdateCheckEnabled();
  const ref = useRef(selection);
  ref.current = updateCheck ? selection : withoutTaskAnswersCheck(selection);
  return ref;
}
