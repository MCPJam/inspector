import type { ComponentProps } from "react";
import { useQuery } from "convex/react";
import type { PlatformEvalIterationReport } from "@mcpjam/sdk/platform";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import { TrialScorecard } from "./trial-scorecard";

type Props = ComponentProps<typeof TrialScorecard>;
function Subscriber(props: Props) {
  const report = useQuery(
    "evalFindingsPipelineState:getEvalIterationReport" as never,
    props.iteration?._id
      ? ({ iterationId: props.iteration._id } as never)
      : "skip",
  ) as PlatformEvalIterationReport | null | undefined;
  return <TrialScorecard {...props} report={report} />;
}

/** An older deployment still renders the recorded scorecard. Reads never trigger spend. */
export function IterationReportScorecard(props: Props) {
  return (
    <ErrorBoundary
      key={props.iteration?._id}
      name="iteration-report"
      isExpectedError={(error) =>
        error.message.includes(
          "evalFindingsPipelineState:getEvalIterationReport",
        ) &&
        /Could not find public function|Function not found/i.test(error.message)
      }
      fallback={<TrialScorecard {...props} />}
    >
      <Subscriber {...props} />
    </ErrorBoundary>
  );
}
