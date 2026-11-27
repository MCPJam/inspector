import type { Meta, StoryObj } from "@storybook/react-vite";
import { Syringe, Wrench } from "lucide-react";
import { CaseFieldDependency } from "@/components/evals/evaluator-library/case-field-dependency";
import { EvaluatorCard } from "@/components/evals/evaluator-library/evaluator-card";
import { EvaluatorKindBadge } from "@/components/evals/evaluator-library/evaluator-kind-badge";
import { Grid, Specimen } from "./_frame";

/** The library grid: cards and badges. */
const meta = {
  title: "Evaluator Library/1 Library",
  parameters: { layout: "padded" },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const toolCalls = {
  name: "Expected Tool Calls",
  question: "Did the agent call the tools this case expects, in order?",
  icon: Wrench,
  tone: "tools" as const,
  builtFrom: [{ kind: "assertions" as const, label: "3 assertions" }],
  onOpen: () => {},
  onAdd: () => {},
};

export const Cards: Story = {
  render: () => (
    <Grid>
      <Specimen label="default · needs a case field" width={340}>
        <EvaluatorCard {...toolCalls} dependency="expectedToolCalls" />
      </Specimen>
      <Specimen label="selected · in suite" width={340}>
        <EvaluatorCard {...toolCalls} selected inSuite />
      </Specimen>
      <Specimen label="security · needs a case field" width={340}>
        <EvaluatorCard
          name="Ignores Injected Instructions"
          question="Did the agent ignore instructions planted in a tool result?"
          icon={Syringe}
          tone="security"
          builtFrom={[
            { kind: "assertions", label: "2 assertions" },
            { kind: "question", label: "1 yes/no question" },
          ]}
          dependency="attackFixture"
          onOpen={() => {}}
          onAdd={() => {}}
        />
      </Specimen>
    </Grid>
  ),
};

export const Labels: Story = {
  render: () => (
    <Grid>
      <Specimen label="method">
        <div className="flex flex-wrap gap-2">
          <EvaluatorKindBadge method="assertions" />
          <EvaluatorKindBadge method="judge" />
          <EvaluatorKindBadge method="decision" />
        </div>
      </Specimen>
      <Specimen label="origin">
        <div className="flex flex-wrap gap-2">
          <EvaluatorKindBadge origin="library" />
          <EvaluatorKindBadge origin="library-copy" />
          <EvaluatorKindBadge origin="github" />
        </div>
      </Specimen>
      <Specimen label="case field dependency">
        <div className="flex flex-col items-start gap-2">
          <CaseFieldDependency field="expectedToolCalls" />
          <CaseFieldDependency
            field="expectedOutput"
            coverage={{ filled: 9, total: 12 }}
          />
          <CaseFieldDependency field="attackFixture" filled={false} />
        </div>
      </Specimen>
    </Grid>
  ),
};
