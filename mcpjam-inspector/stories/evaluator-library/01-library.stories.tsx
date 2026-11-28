import type { Meta, StoryObj } from "@storybook/react-vite";
import { EvaluatorCard } from "@/components/evals/evaluator-library/evaluator-card";
import { EvaluatorKindBadge } from "@/components/evals/evaluator-library/evaluator-kind-badge";
import {
  builtFrom,
  findLibraryEvaluator,
  type LibraryEvaluator,
} from "@/components/evals/evaluator-library/library-catalog";
import { Grid, Specimen } from "./_frame";

/** The library grid: preset cards as the dialog renders them, and the badge. */
const meta = {
  title: "Evaluator Library/1 Library",
  parameters: { layout: "padded" },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

function preset(id: string): LibraryEvaluator {
  const entry = findLibraryEvaluator(id);
  if (!entry) throw new Error(`No library preset ${id}`);
  return entry;
}

function card(entry: LibraryEvaluator) {
  return {
    name: entry.name,
    question: entry.question,
    icon: entry.icon,
    tone: entry.tone,
    builtFrom: builtFrom(entry),
    onOpen: () => {},
    onAdd: () => {},
  };
}

export const Cards: Story = {
  render: () => (
    <Grid>
      <Specimen label="assertions" width={340}>
        <EvaluatorCard {...card(preset("no-wasted-calls"))} />
      </Specimen>
      <Specimen label="in suite" width={340}>
        <EvaluatorCard {...card(preset("reports-tool-errors"))} inSuite />
      </Specimen>
      <Specimen label="judge · add refused" width={340}>
        <EvaluatorCard
          {...card(preset("answers-the-question"))}
          addDisabledReason="Suites can have up to 5 judges, and adding this evaluator would make 6. Remove a judge first."
        />
      </Specimen>
    </Grid>
  ),
};

export const Labels: Story = {
  render: () => (
    <Grid>
      <Specimen label="origin">
        <EvaluatorKindBadge origin="library" />
      </Specimen>
    </Grid>
  ),
};
