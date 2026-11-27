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
  { name: "user_prompt", description: "The user's request" },
  { name: "tool_results", description: "Each tool step with its result" },
  { name: "final_answer", description: "The agent's final answer" },
];

export const JudgePrompt: Story = {
  render: function Render() {
    const [prompt, setPrompt] = useState(
      "Read {{user_prompt}} and {{tool_results}}.\nDid {{final_answer}} only recommend items in stock? Also check {{cart}}.",
    );
    return (
      <Grid>
        <Specimen
          label="prompt · type {{ to insert · cart is unknown"
          width={560}
        >
          <PromptEditor
            value={prompt}
            onChange={setPrompt}
            variables={variables}
            maxLength={4000}
          />
        </Specimen>
        <Specimen label="variable mapping" width={680}>
          <VariableMappingTable variables={variables} />
        </Specimen>
      </Grid>
    );
  },
};
