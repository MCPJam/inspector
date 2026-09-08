import type { UiToolDefinition } from "../ui-tools-registry";
import {
  evalTurnScope,
  assertEvalToolAllowed,
} from "@/lib/mcpjam-agent/eval-scope";
import {
  getEvalDraft,
  getEvalSuite,
  useEvalGeneration,
  evalSuiteKey,
  parseDraftPatch,
  startEvalGeneration,
  runScopedEvalSuite,
  editGeneratedDraft,
} from "@/lib/mcpjam-agent/eval-workspace";

const revision = {
  type: "string",
  description: "Exact current revision returned by ui_eval_context.",
};
const patch = {
  title: { type: "string", description: "New case title." },
  steps: {
    type: "array",
    description:
      "Complete ordered TestStep sequence; preserve unchanged steps and ids. Kinds: prompt {id,kind,prompt}; assert {id,kind,assertion}; toolCall {id,kind,toolName,arguments}; interact. Read the current steps first. Example assert: {id:'check-1',kind:'assert',assertion:{type:'responseContains',needle:'hello'}}. Validated against the shared eval step contract.",
    items: { type: "object", additionalProperties: true },
  },
};
export function buildEvalAuthoringTools(): UiToolDefinition[] {
  return [
    {
      name: "ui_eval_run_suite",
      description:
        "Run ALL SAVED cases in the scoped suite without navigation. Does not run unsaved drafts. Spends eval usage and executes real server tools; approval required. Only use when the user requests a suite run. Read context for results.",
      readOnly: false,
      properties: {},
    },
    {
      name: "ui_eval_context",
      description:
        "Read the scoped suite, current case draft and revision, connected tool metadata, and generated drafts/progress. Never navigates.",
      readOnly: true,
      properties: {},
    },
    {
      name: "ui_eval_edit_case",
      description:
        "Update the scoped case's working draft. Requires its exact current revision. Returns changed fields and revision; user saves from the editor. Never navigates.",
      readOnly: false,
      properties: { revision, ...patch },
      required: ["revision"],
    },
    {
      name: "ui_eval_undo_case",
      description:
        "Undo the latest agent edit to the scoped draft only if its revision still matches. Never overwrites later manual edits.",
      readOnly: false,
      properties: { revision },
      required: ["revision"],
    },
    {
      name: "ui_eval_generate_cases",
      description:
        "Generate additional coverage from connected servers into reviewable drafts. Spends model usage; approval required. Does not save or run cases. Read context for progress, never restart a running job.",
      readOnly: false,
      properties: {
        instructions: {
          type: "string",
          description:
            "Coverage goal, constraints and refinement direction for NEW cases.",
        },
      },
      required: ["instructions"],
    },
    {
      name: "ui_eval_edit_generated_case",
      description:
        "Refine an existing generated draft in the scoped suite. Requires its id and revision from context. Does not generate duplicates or save.",
      readOnly: false,
      properties: { draftId: { type: "string" }, revision, ...patch },
      required: ["draftId", "revision"],
    },
  ].map((spec) => ({
    name: spec.name,
    description: spec.description,
    readOnly: spec.readOnly,
    annotations: {
      readOnlyHint: spec.readOnly,
      destructiveHint: ["ui_eval_generate_cases", "ui_eval_run_suite"].includes(
        spec.name,
      ),
      idempotentHint: spec.readOnly,
      openWorldHint: ["ui_eval_generate_cases", "ui_eval_run_suite"].includes(
        spec.name,
      ),
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
      if (spec.name === "ui_eval_run_suite") {
        result = await runScopedEvalSuite(scope);
      } else if (spec.name === "ui_eval_context") {
        result = {
          scope,
          suite: getEvalSuite(scope).read(),
          ...(scope.caseId ? { case: getEvalDraft(scope).read() } : {}),
          generation:
            useEvalGeneration.getState().suites[evalSuiteKey(scope)] ?? null,
        };
      } else if (spec.name === "ui_eval_generate_cases") {
        if (typeof args.instructions !== "string" || !args.instructions.trim())
          throw new Error("Describe the requested coverage.");
        result = startEvalGeneration(scope, args.instructions);
      } else {
        if (typeof args.revision !== "string")
          throw new Error("Read context and provide its current revision.");
        if (spec.name === "ui_eval_undo_case")
          result = getEvalDraft(scope).undo(args.revision);
        else if (spec.name === "ui_eval_edit_case")
          result = getEvalDraft(scope).edit(
            args.revision,
            parseDraftPatch(args),
          );
        else {
          if (typeof args.draftId !== "string")
            throw new Error("Provide the generated draft id.");
          result = editGeneratedDraft(
            scope,
            args.draftId,
            args.revision,
            parseDraftPatch(args),
          );
        }
      }
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  }));
}
