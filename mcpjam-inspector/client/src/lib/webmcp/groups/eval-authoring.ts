import {
  askDescribeQuestion,
  proposeDescribeCases,
  useDescribeFlow,
} from "@/lib/mcpjam-agent/describe-flow";
import type { UiToolDefinition } from "../ui-tools-registry";
import {
  evalTurnScope,
  assertEvalToolAllowed,
} from "@/lib/mcpjam-agent/eval-scope";
import {
  readEvalContext,
  useEvalGeneration,
  evalSuiteKey,
} from "@/lib/mcpjam-agent/eval-workspace";

const revision = {
  type: "string",
  description: "Exact current revision returned by ui_eval_context.",
};
const patch = {
  expectedOutput: {
    type: "string",
    description: "What a successful response must do for this case.",
  },
  title: { type: "string", description: "New case title." },
  steps: {
    type: "array",
    description:
      "Complete ordered TestStep sequence; preserve unchanged steps and ids. Kinds: prompt {id,kind,prompt}; assert {id,kind,assertion}; toolCall {id,kind,serverName,toolName,arguments}; interact. Read the current steps first. Example assert: {id:'check-1',kind:'assert',assertion:{type:'responseContains',needle:'hello'}}. Validated against the shared eval step contract.",
    items: { type: "object", additionalProperties: true },
  },
};
export function buildEvalAuthoringTools(): UiToolDefinition[] {
  return [
    {
      name: "ui_eval_question",
      description:
        "Ask the single allowed follow-up about the expected outcome, then stop and wait for the user's next message. Never edits a case.",
      readOnly: true,
      properties: { question: { type: "string" } },
      required: ["question"],
    },
    {
      name: "ui_eval_propose_cases",
      description:
        "Prepare 1–5 cases for a Create button. Does not edit or save cases. Stop after this tool. Each case has title and ordered steps with prompts and checks.",
      readOnly: true,
      properties: {
        revision,
        subject: {
          type: "string",
          description: "Short subject, e.g. issue search; max 80 characters.",
        },
        summary: {
          type: "string",
          description:
            "One sentence describing expected behavior, max 300 characters.",
        },
        cases: {
          type: "array",
          minItems: 1,
          maxItems: 5,
          items: {
            type: "object",
            properties: patch,
            required: ["title", "steps"],
            additionalProperties: false,
          },
        },
      },
      required: ["revision", "subject", "summary", "cases"],
    },
    {
      name: "ui_eval_context",
      description:
        "Read the scoped suite, current case draft and revision, connected tool metadata, and generated drafts/progress. Never navigates.",
      readOnly: true,
      properties: {},
    },
  ].map((spec) => ({
    name: spec.name,
    description: spec.description,
    readOnly: spec.readOnly,
    annotations: {
      readOnlyHint: spec.readOnly,
      destructiveHint: false,
      idempotentHint: spec.name === "ui_eval_context",
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: spec.properties,
      required: spec.required ?? [],
      additionalProperties: false,
    },
    execute: async (args, context) => {
      if (!context?.scope)
        throw new Error("Eval authoring requires a scoped agent session.");
      assertEvalToolAllowed(context.scope, spec.name);
      const scope = evalTurnScope(context.scope);
      if (!scope)
        throw new Error("Open Ask MCPJam from the eval workspace first.");
      let result: unknown;
      if (spec.name === "ui_eval_question") {
        result = askDescribeQuestion(
          context.scope,
          String(args.question ?? ""),
        );
      } else if (spec.name === "ui_eval_propose_cases") {
        result = {
          status: "proposed",
          proposalId: proposeDescribeCases(context.scope, scope, args),
          instruction: "Stop. The user can now click Create.",
        };
      } else if (spec.name === "ui_eval_context") {
        result = {
          scope,
          workflow: useDescribeFlow.getState().sessions[context.scope] ?? null,
          ...readEvalContext(scope),
          generation:
            useEvalGeneration.getState().suites[evalSuiteKey(scope)] ?? null,
        };
      }
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  }));
}
