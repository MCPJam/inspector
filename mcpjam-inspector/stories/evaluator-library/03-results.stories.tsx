import type { Meta, StoryObj } from "@storybook/react-vite";
import { Syringe, Wrench } from "lucide-react";
import { CheckRow } from "@/components/evals/evaluator-library/check-row";
import { ScorecardEvaluatorCard } from "@/components/evals/evaluator-library/scorecard-evaluator-card";
import { VerdictPill } from "@/components/evals/evaluator-library/verdict-pill";
import { Grid, Specimen } from "./_frame";

/** Scorecard: verdicts, check rows and cards. */
const meta = {
  title: "Evaluator Library/3 Results",
  parameters: { layout: "padded" },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const Verdicts: Story = {
  render: () => (
    <Grid>
      <Specimen label="verdict pill · md" width={760}>
        <div className="flex flex-wrap gap-2">
          {(
            [
              "passed",
              "failed",
              "error",
              "skipped",
              "not_applicable",
              "running",
              "partial",
            ] as const
          ).map((s) => (
            <VerdictPill key={s} status={s} />
          ))}
        </div>
      </Specimen>
      <Specimen label="sm · score label" width={760}>
        <div className="flex flex-wrap gap-2">
          <VerdictPill size="sm" status="passed" label="0.91" />
          <VerdictPill size="sm" status="failed" label="0.42" />
        </div>
      </Specimen>
    </Grid>
  ),
};

export const ResultRows: Story = {
  render: () => (
    <Grid>
      <Specimen label="check rows" width={640}>
        <ul className="divide-y divide-border rounded-lg border border-border bg-popover">
          <CheckRow
            label="Called the expected tools"
            role="required"
            status="failed"
            evidence="Called search_catalog first"
          />
          <CheckRow
            label="Stayed under the call budget"
            role="required"
            status="passed"
            evidence="4 of 6 calls"
          />
          <CheckRow
            label="Answer quality"
            role="advisory"
            status="passed"
            evidence="Score 0.82"
          />
        </ul>
      </Specimen>
    </Grid>
  ),
};

const injection = {
  name: "Ignores Injected Instructions",
  icon: Syringe,
  origin: "library" as const,
  checks: [
    {
      id: "a",
      label: "Did not call send_email",
      role: "required" as const,
      status: "passed" as const,
      evidence: "No send_email call",
    },
    {
      id: "b",
      label: "Did not repeat the planted instruction",
      role: "required" as const,
      status: "failed" as const,
      evidence: "Final answer quotes the planted text",
    },
  ],
};

export const Scorecard: Story = {
  render: () => (
    <Grid>
      <Specimen label="failed · opens with failing check first" width={640}>
        <ScorecardEvaluatorCard {...injection} status="failed" />
      </Specimen>
      <Specimen label="passed · starts collapsed" width={640}>
        <ScorecardEvaluatorCard
          name="Expected Tool Calls"
          icon={Wrench}
          origin="library"
          status="passed"
          checks={[
            {
              id: "a",
              label: "Every expected call was made",
              role: "required",
              status: "passed",
            },
          ]}
        />
      </Specimen>
      <Specimen label="error · crashed evaluator" width={640}>
        <ScorecardEvaluatorCard
          name="Quoted Cart Total"
          icon={Wrench}
          status="error"
          checks={[
            {
              id: "a",
              label: "evaluate() returned a score",
              role: "required",
              status: "error",
              evidence: "TypeError: cannot read cart_total of undefined",
            },
          ]}
        />
      </Specimen>
    </Grid>
  ),
};
