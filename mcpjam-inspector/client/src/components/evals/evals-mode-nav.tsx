import { FlaskConical, GitBranch } from "lucide-react";
import { SegmentedControl } from "@/components/ui/json-editor/segmented-control";
import {
  buildEvalsPath,
  buildEvalsRunsPath,
  navigateApp,
} from "@/lib/app-navigation";
import type { EvalsMode } from "@/lib/eval-route-url";

/**
 * Suites | Runs — the two lenses over the same eval suites, switched in the
 * Evaluate header rather than in the sidebar.
 *
 * Switching always lands on the target mode's list. The modes address suites
 * under different prefixes, so carrying the current route across would deep
 * link into a suite through the other lens, which is a different question than
 * the one the user asked by clicking the other tab.
 */
export function EvalsModeNav({ mode }: { mode: EvalsMode }) {
  return (
    <SegmentedControl
      value={mode}
      onChange={(next) => {
        if (next === mode) return;
        navigateApp(
          next === "runs"
            ? buildEvalsRunsPath({ type: "list" })
            : buildEvalsPath({ type: "list" }),
        );
      }}
      size="default"
      className="shrink-0"
      options={[
        {
          value: "suites",
          label: "Suites",
          icon: <FlaskConical className="h-4 w-4" />,
          title: "Author and run eval suites",
        },
        {
          value: "runs",
          label: "Runs",
          icon: <GitBranch className="h-4 w-4" />,
          title: "Review eval results from CI, grouped by commit",
        },
      ]}
    />
  );
}
