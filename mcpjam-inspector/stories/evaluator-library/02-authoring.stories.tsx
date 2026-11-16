import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { CombineFlow } from "@/components/evals/evaluator-library/combine-flow";
import { EvaluatorPreviewPanel } from "@/components/evals/evaluator-library/evaluator-preview-panel";
import { EvaluatorTypePicker } from "@/components/evals/evaluator-library/evaluator-type-picker";
import type { EvaluatorMethod } from "@/components/evals/evaluator-library/evaluator-library-types";
import { ExpectationField } from "@/components/evals/evaluator-library/expectation-field";
import {
  ModelQuestionCard,
  type ModelQuestion,
} from "@/components/evals/evaluator-library/model-question-card";
import {
  OutputFormatControl,
  type JudgeOutput,
} from "@/components/evals/evaluator-library/output-format-control";
import { PromptEditor } from "@/components/evals/evaluator-library/prompt-editor";
import { ReviewerExampleRow } from "@/components/evals/evaluator-library/reviewer-example-row";
import {
  RunWhenSelect,
  type RunWhen,
} from "@/components/evals/evaluator-library/run-when-select";
import {
  VariableMappingTable,
  type PromptVariable,
} from "@/components/evals/evaluator-library/variable-mapping-table";
import { Grid, Specimen } from "./_frame";

/** Building a custom evaluator: method, gates, questions, judge prompt. */
const meta = {
  title: "Evaluator Library/2 Authoring",
  parameters: { layout: "padded" },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const MethodAndGate: Story = {
  render: function Render() {
    const [method, setMethod] = useState<EvaluatorMethod>("assertions");
    const [runWhen, setRunWhen] = useState<RunWhen>("required-pass");
    return (
      <Grid>
        <Specimen label="type picker" width={900}>
          <EvaluatorTypePicker value={method} onChange={setMethod} />
        </Specimen>
        <Specimen label="run when" width={320}>
          <RunWhenSelect value={runWhen} onChange={setRunWhen} />
        </Specimen>
        <Specimen label="combine flow" width={640}>
          <CombineFlow
            requiredCount={3}
            explainStep="Ask why"
            dependency="expectedToolCalls"
          />
        </Specimen>
      </Grid>
    );
  },
};

const baseQuestion: ModelQuestion = {
  label: "Did the agent ask before placing the order?",
  kind: "yesno",
  passOn: "yes",
  options: [
    { label: "Asked first", passes: true },
    { label: "Ordered without asking", passes: false },
    { label: "Did not order", passes: true },
  ],
  threshold: 0.7,
  runWhen: "always",
  role: "advisory",
};

export const ModelQuestions: Story = {
  render: function Render() {
    const [q, setQ] = useState(baseQuestion);
    const [perMatch, setPerMatch] = useState<ModelQuestion>({
      ...baseQuestion,
      label: "Is this a real secret?",
      runWhen: "per-match",
    });
    return (
      <Grid>
        <Specimen label="interactive · switch the kind">
          <ModelQuestionCard value={q} onChange={setQ} onRemove={() => {}} />
        </Specimen>
        <Specimen label="per match · find then confirm">
          <ModelQuestionCard
            value={perMatch}
            onChange={setPerMatch}
            estimatedCalls={12}
          />
        </Specimen>
      </Grid>
    );
  },
};

const variables: PromptVariable[] = [
  {
    name: "user_request",
    path: "trace.messages.lastUser",
    preview: "find me wireless earbuds under $150",
  },
  {
    name: "tool_results",
    path: "transcript.toolResults",
    preview: '[{ "title": "Echo Buds", "in_stock": false }]',
  },
  { name: "final_answer", path: "transcript.finalText", preview: "I found…" },
];

const paths = [
  "trace.messages.lastUser",
  "transcript.toolResults",
  "transcript.finalText",
  "case.expectedOutput",
];

export const JudgePrompt: Story = {
  render: function Render() {
    const [prompt, setPrompt] = useState(
      "Read {{user_request}} and {{tool_results}}.\nDid {{final_answer}} only recommend items in stock? Also check {{cart}}.",
    );
    const [vars, setVars] = useState(variables);
    const [output, setOutput] = useState<JudgeOutput>({
      format: "score",
      threshold: 0.7,
      categories: [],
      explanationFirst: true,
    });
    return (
      <Grid>
        <Specimen
          label="prompt · type {{ to insert · cart is unknown"
          width={560}
        >
          <PromptEditor
            value={prompt}
            onChange={setPrompt}
            variables={vars}
            scope="iteration"
          />
        </Specimen>
        <Specimen label="variable mapping" width={680}>
          <VariableMappingTable
            variables={vars}
            paths={paths}
            previewLabel="Iteration #3"
            onPathChange={(name, path) =>
              setVars((all) =>
                all.map((v) => (v.name === name ? { ...v, path } : v)),
              )
            }
          />
        </Specimen>
        <Specimen label="output format" width={420}>
          <OutputFormatControl value={output} onChange={setOutput} />
        </Specimen>
      </Grid>
    );
  },
};

export const PreviewAndExamples: Story = {
  render: function Render() {
    const [included, setIncluded] = useState(true);
    return (
      <Grid>
        <Specimen label="preview on past iterations" width={560}>
          <EvaluatorPreviewPanel
            sourceLabel="Run #4 · last 3 iterations"
            iterationCount={3}
            costLabel="About $0.02"
            results={[
              {
                id: "1",
                iterationLabel: "Iteration #1",
                status: "passed",
                explanation: "Recommended two in-stock earbuds.",
              },
              {
                id: "2",
                iterationLabel: "Iteration #2",
                status: "failed",
                explanation: "Recommended Echo Buds, which are out of stock.",
              },
              {
                id: "3",
                iterationLabel: "Iteration #3",
                status: "not_applicable",
                explanation: "The agent asked a clarifying question.",
              },
            ]}
            onRun={() => {}}
            onCorrect={() => {}}
          />
        </Specimen>
        <Specimen label="reviewer example" width={560}>
          <ReviewerExampleRow
            iterationLabel="Run #3 · Iteration #4"
            judgeSaid="passed"
            reviewerSaid="failed"
            reviewer="Matt"
            note="Recommended Echo Buds, which search returned with in_stock false."
            included={included}
            onIncludedChange={setIncluded}
          />
        </Specimen>
      </Grid>
    );
  },
};

export const CaseExpectations: Story = {
  render: () => (
    <Grid>
      <Specimen label="read by evaluators on this suite">
        <ExpectationField
          field="postCondition"
          isNew
          readBy={[{ evaluatorId: "pc", name: "Post-condition Holds" }]}
        >
          <textarea
            aria-label="Post-condition"
            className="w-full rounded-md border border-input bg-background p-2 text-sm"
            defaultValue="get_order returns status: confirmed"
          />
        </ExpectationField>
      </Specimen>
      <Specimen label="no evaluator reads it">
        <ExpectationField field="callBudget" readBy={[]}>
          <input aria-label="Call budget" />
        </ExpectationField>
      </Specimen>
    </Grid>
  ),
};
