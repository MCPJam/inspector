import type { Meta, StoryObj } from "@storybook/react-vite";
import { ListChecks, Server, Syringe, Wrench } from "lucide-react";
import { CaseFieldDependency } from "@/components/evals/evaluator-library/case-field-dependency";
import { EvaluatorCard } from "@/components/evals/evaluator-library/evaluator-card";
import {
  EvaluatorKindBadge,
  OwaspTag,
} from "@/components/evals/evaluator-library/evaluator-kind-badge";
import { NotInLibraryCard } from "@/components/evals/evaluator-library/not-in-library-card";
import { Grid, Specimen } from "./_frame";

/** The library grid: cards, badges and the "not in the library" card. */
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
      <Specimen label="security · OWASP" width={340}>
        <EvaluatorCard
          name="Ignores Injected Instructions"
          question="Did the agent ignore instructions planted in a tool result?"
          icon={Syringe}
          tone="security"
          builtFrom={[
            { kind: "assertions", label: "2 assertions" },
            { kind: "question", label: "1 yes/no question" },
          ]}
          owasp={["MCP06"]}
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
          <EvaluatorKindBadge method="code" />
        </div>
      </Specimen>
      <Specimen label="origin · OWASP">
        <div className="flex flex-wrap gap-2">
          <EvaluatorKindBadge origin="library" />
          <EvaluatorKindBadge origin="library-copy" />
          <EvaluatorKindBadge origin="github" />
          <OwaspTag ids={["MCP01", "MCP10"]} />
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

export const NotInLibrary: Story = {
  render: () => (
    <Grid>
      <Specimen label="server checks" width={420}>
        <NotInLibraryCard
          icon={Server}
          title="Server checks"
          description="Grade the server. Run once per deploy."
          items={["Tool catalog review", "Security probes"]}
          actionLabel="Open server checks"
          onAction={() => {}}
        />
      </Specimen>
      <Specimen label="run settings" width={420}>
        <NotInLibraryCard
          icon={ListChecks}
          title="Run settings"
          description="Change how a suite runs."
          items={["Client matrix", "Trials per case"]}
          actionLabel="Open run settings"
          onAction={() => {}}
        />
      </Specimen>
    </Grid>
  ),
};
