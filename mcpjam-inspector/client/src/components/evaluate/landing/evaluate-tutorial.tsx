import {
  createContext,
  useContext,
  useEffect,
  useRef,
  type ReactNode,
} from "react";
import { HowSuitesWorkDialog } from "../how-suites-work/how-suites-work-dialog";
import { useHowSuitesWork } from "../how-suites-work/use-how-suites-work";
import type { HowSuitesWorkTrigger } from "../how-suites-work/how-suites-work-model";
import { useEvaluateSuiteOverview } from "./use-evaluate-suite-overview";

type RequestTutorial = (trigger: HowSuitesWorkTrigger) => boolean;

const EvaluateTutorialContext = createContext<RequestTutorial | null>(null);

/** Opens the tutorial from a page; null when the nav rework is off. */
export function useEvaluateTutorial(): RequestTutorial | null {
  return useContext(EvaluateTutorialContext);
}

/**
 * Owns the How suites work dialog for every Evaluate page, so it survives
 * route changes and can open after the first suite is created wherever that
 * happened. The tree keeps the same shape when `enabled` flips, so today's
 * Evaluate tab is not remounted when the flag loads.
 */
export function EvaluateTutorialProvider({
  enabled,
  projectId,
  children,
}: {
  enabled: boolean;
  projectId?: string | null;
  children: ReactNode;
}) {
  const { trigger, request, close } = useHowSuitesWork();
  return (
    <EvaluateTutorialContext.Provider value={enabled ? request : null}>
      {children}
      {enabled && projectId ? (
        <FirstSuiteWatcher
          key={projectId}
          projectId={projectId}
          onFirstSuite={() => request("first_suite")}
        />
      ) : null}
      {enabled ? (
        <HowSuitesWorkDialog trigger={trigger} onClose={close} />
      ) : null}
    </EvaluateTutorialContext.Provider>
  );
}

/** Calls `onFirstSuite` when a project seen with no suites gets its first. */
function FirstSuiteWatcher({
  projectId,
  onFirstSuite,
}: {
  projectId: string;
  onFirstSuite: () => void;
}) {
  const { suites, isLoading } = useEvaluateSuiteOverview(projectId);
  const count = isLoading ? null : suites.length;
  const hadNone = useRef(false);
  const onFirstSuiteRef = useRef(onFirstSuite);
  onFirstSuiteRef.current = onFirstSuite;

  useEffect(() => {
    if (count === null) return;
    if (count === 0) {
      hadNone.current = true;
    } else if (hadNone.current) {
      hadNone.current = false;
      onFirstSuiteRef.current();
    }
  }, [count]);

  return null;
}
