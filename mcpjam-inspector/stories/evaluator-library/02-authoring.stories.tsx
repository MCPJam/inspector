import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { PromptEditor } from "@/components/evals/evaluator-library/prompt-editor";
import {
  VariableMappingTable,
  type PromptVariable,
} from "@/components/evals/evaluator-library/variable-mapping-table";
import { Grid, Specimen } from "./_frame";

/** Writing a judge prompt and mapping variables. */
const meta = {
  title: "Evaluator Library/2 Authoring",
  parameters: { layout: "padded" },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

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
      </Grid>
    );
  },
};
