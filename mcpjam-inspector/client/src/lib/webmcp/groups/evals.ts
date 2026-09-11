/**
 * Evals-screen tools: run/cancel/generate/delete existing suites, and open
 * the create-suite dialog with an optional name prefill.
 *
 * Mount-scoped like the registry group: `EvalsTab` owns the command handlers
 * and the suites they resolve against, so the tools exist exactly while
 * `/evals` is mounted. Two deliberate postures:
 *
 * - **Prefill over commit.** Suite CREATION is high-entropy (model, host and
 *   server attachments, test cases), so `ui_open_eval_suite_form` only opens
 *   the dialog for the human — the `ui_open_server_form` precedent. Acting
 *   on an EXISTING suite (run/cancel/generate/delete) is low-entropy and
 *   executes directly.
 * - **Billing.** Runs go through the SAME quota-gated callback the Run
 *   button uses; an exhausted eval-iteration quota comes back as a command
 *   error naming the quota, never a bypass. Generation spends money, so it
 *   is `destructiveHint: true` and gates on the approval pill.
 */

import type { UiToolDefinition } from "../ui-tools-registry";
import {
  commandResponseToActionResult,
  dispatchInspectorCommand,
} from "../ui-actions";
import { asOptionalString, errorResult, fromActionResult } from "./shared";

const SUITE_PROPERTY = {
  type: "string",
  description:
    "Eval suite as the Evaluate screen shows it: its name (e.g. 'Asana smoke tests') or its suite id.",
} as const;

function requireSuite(value: unknown) {
  const suite = asOptionalString(value);
  return suite ?? null;
}

export function buildEvalsUiTools(): UiToolDefinition[] {
  return [
    {
      name: "ui_open_eval_suite_form",
      description:
        "Open the create-suite dialog on the Evaluate screen for the user to fill in and submit. Optionally prefills the suite name — nothing else. This only prepares the form; it never creates the suite (the user picks servers/hosts and submits). To act on an existing suite, use the run/generate/delete eval tools instead.",
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Optional suite name to prefill in the dialog.",
          },
        },
        additionalProperties: false,
      },
      readOnly: false,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      // Opens the /evals/create route (the dialog) on the Evaluate screen.
      mayNavigate: true,
      execute: async (args) => {
        const name = asOptionalString(args.name);
        if (args.name !== undefined && name === undefined) {
          return errorResult("'name' must be a non-empty string when provided.");
        }
        const response = await dispatchInspectorCommand({
          type: "openEvalSuiteForm",
          payload: { ...(name ? { name } : {}) },
        });
        return fromActionResult(commandResponseToActionResult(response));
      },
    },
    {
      name: "ui_run_eval_suite",
      description:
        "Start a run of an existing eval suite — real model and MCP tool calls that SPEND the organization's eval iteration quota (same gate as the Run button; an exhausted quota is reported as an error, and the run is refused). The run continues in the background; observe progress with ui_snapshot_app.",
      inputSchema: {
        type: "object",
        properties: { suite: SUITE_PROPERTY },
        required: ["suite"],
        additionalProperties: false,
      },
      readOnly: false,
      // Real LLM + third-party MCP server traffic that SPENDS quota; per the
      // guide, a money/quota-spending action gates on the confirmation pill.
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      // A successful single-host launch lands on the new run's detail page.
      mayNavigate: true,
      execute: async (args) => {
        const suite = requireSuite(args.suite);
        if (!suite) {
          return errorResult("Missing required 'suite' string.");
        }
        const response = await dispatchInspectorCommand({
          type: "runEvalSuite",
          payload: { suite },
        });
        return fromActionResult(commandResponseToActionResult(response));
      },
    },
    {
      name: "ui_cancel_eval_run",
      description:
        "Cancel an in-progress eval run by its run id (full id, or the shortened id the runs list displays). Cancelling stops work and spends nothing; a run that already finished is reported as such.",
      inputSchema: {
        type: "object",
        properties: {
          runId: {
            type: "string",
            description:
              "The run to cancel: its id, full or as shown in the runs list.",
          },
        },
        required: ["runId"],
        additionalProperties: false,
      },
      readOnly: false,
      // Stops work rather than destroying data, and re-cancelling a
      // cancelled run changes nothing.
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      execute: async (args) => {
        const runId = asOptionalString(args.runId);
        if (!runId) {
          return errorResult("Missing required 'runId' string.");
        }
        const response = await dispatchInspectorCommand({
          type: "cancelEvalRun",
          payload: { runId },
        });
        return fromActionResult(commandResponseToActionResult(response));
      },
    },
    {
      name: "ui_generate_eval_tests",
      description:
        "Generate suggested test cases for an existing eval suite using an LLM over the suite's connected servers. SPENDS MONEY and adds the generated cases to the suite. Generation runs in the background; new cases appear in the suite's case list (check with ui_snapshot_app).",
      inputSchema: {
        type: "object",
        properties: { suite: SUITE_PROPERTY },
        required: ["suite"],
        additionalProperties: false,
      },
      readOnly: false,
      // Spends money and mutates the suite → destructive, so the approval
      // pill gates it even in the default mode. Talks to a model and the
      // suite's MCP servers.
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      execute: async (args) => {
        const suite = requireSuite(args.suite);
        if (!suite) {
          return errorResult("Missing required 'suite' string.");
        }
        const response = await dispatchInspectorCommand({
          type: "generateEvalTests",
          payload: { suite },
        });
        return fromActionResult(commandResponseToActionResult(response));
      },
    },
    {
      name: "ui_edit_eval_case_draft",
      description:
        "Edit the test case CURRENTLY OPEN in the case editor (e.g. the 'Describe a case' workspace) — there is no suite/case id to pass, it always targets whatever case is on screen. Set 'prompt' to (re)write the case's user-turn prompt, 'addToolAssertion' to add a check that a specific tool was called with given arguments, or 'noTool' to mark the case as expecting no tool call. Fails with an error if no case is currently open for editing.",
      inputSchema: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description:
              "The user prompt this case's first turn should send. Replaces whatever prompt the case already had.",
          },
          addToolAssertion: {
            type: "object",
            description:
              "Add a check that the given tool was called with these arguments.",
            properties: {
              toolName: { type: "string" },
              arguments: {
                type: "object",
                description: "Expected arguments, as a plain object.",
              },
            },
            required: ["toolName"],
            additionalProperties: false,
          },
          noTool: {
            type: "boolean",
            description: "Mark the case as expecting no tool call at all.",
          },
        },
        additionalProperties: false,
      },
      readOnly: false,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      execute: async (args) => {
        const prompt = asOptionalString(args.prompt);
        if (args.prompt !== undefined && prompt === undefined) {
          return errorResult(
            "'prompt' must be a non-empty string when provided.",
          );
        }
        let addToolAssertion:
          | { toolName: string; arguments?: Record<string, unknown> }
          | undefined;
        if (args.addToolAssertion !== undefined) {
          const raw = args.addToolAssertion;
          if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
            return errorResult("'addToolAssertion' must be an object.");
          }
          const toolName = asOptionalString(
            (raw as Record<string, unknown>).toolName,
          );
          if (!toolName) {
            return errorResult(
              "'addToolAssertion.toolName' is required and must be a non-empty string.",
            );
          }
          const rawArguments = (raw as Record<string, unknown>).arguments;
          if (
            rawArguments !== undefined &&
            (typeof rawArguments !== "object" ||
              rawArguments === null ||
              Array.isArray(rawArguments))
          ) {
            return errorResult(
              "'addToolAssertion.arguments' must be an object when provided.",
            );
          }
          addToolAssertion = {
            toolName,
            ...(rawArguments
              ? { arguments: rawArguments as Record<string, unknown> }
              : {}),
          };
        }
        if (args.noTool !== undefined && typeof args.noTool !== "boolean") {
          return errorResult("'noTool' must be a boolean when provided.");
        }
        if (
          prompt === undefined &&
          addToolAssertion === undefined &&
          args.noTool === undefined
        ) {
          return errorResult(
            "Provide at least one of 'prompt', 'addToolAssertion', or 'noTool'.",
          );
        }
        const response = await dispatchInspectorCommand({
          type: "editEvalCaseDraft",
          payload: {
            ...(prompt !== undefined ? { prompt } : {}),
            ...(addToolAssertion ? { addToolAssertion } : {}),
            ...(args.noTool !== undefined ? { noTool: args.noTool } : {}),
          },
        });
        return fromActionResult(commandResponseToActionResult(response));
      },
    },
    {
      name: "ui_delete_eval_suite",
      description:
        "Permanently delete an existing eval suite, including its test cases and run history. Irreversible — be sure the user wants this exact suite gone. The suite is addressed by name or id, exactly as shown on the Evaluate screen.",
      inputSchema: {
        type: "object",
        properties: { suite: SUITE_PROPERTY },
        required: ["suite"],
        additionalProperties: false,
      },
      readOnly: false,
      // Irreversible delete → approval pill. Deleting an already-deleted
      // suite fails cleanly rather than deleting something else.
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      execute: async (args) => {
        const suite = requireSuite(args.suite);
        if (!suite) {
          return errorResult("Missing required 'suite' string.");
        }
        const response = await dispatchInspectorCommand({
          type: "deleteEvalSuite",
          payload: { suite },
        });
        return fromActionResult(commandResponseToActionResult(response));
      },
    },
  ];
}
