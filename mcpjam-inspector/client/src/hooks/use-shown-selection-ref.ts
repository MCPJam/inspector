import { useRef } from "react";
import type { ConformanceSelection } from "@/shared/conformance-settings";
import {
  useTasksUpdateCheckEnabled,
  withoutHiddenTasksCheck,
} from "@/components/conformance/conformance-catalogs";

/** A run's picks, read when it starts, minus checks this user can't see. */
export function useShownSelectionRef(selection?: ConformanceSelection) {
  const updateCheck = useTasksUpdateCheckEnabled();
  const ref = useRef(selection);
  ref.current = withoutHiddenTasksCheck(selection, updateCheck);
  return ref;
}
