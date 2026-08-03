/**
 * Core app-wide UI tools: navigation, server focus, emulated app context,
 * the whole-app snapshot, and the clarifying question. Registered globally
 * (never surface-scoped) — they are how the agent moves BETWEEN surfaces, so
 * they must exist on all of them.
 */

import type {
  InspectorAppDeviceType,
  InspectorAppDisplayMode,
  SetAppContextInspectorCommand,
} from "@/shared/inspector-command.js";
import type { UiToolDefinition } from "../ui-tools-registry";
import {
  commandResponseToActionResult,
  dispatchInspectorCommand,
  listUiNavigationTargets,
  navigateAction,
  selectServerAction,
} from "../ui-actions";
import {
  asOptionalString,
  ensurePlaygroundOpen,
  errorResult,
  fromActionResult,
  okResult,
} from "./shared";
import {
  ASK_USER_TOOL_NAME,
  registerAskUserQuestion,
  type AskUserOption,
} from "../ask-user-store";

const DEVICE_TYPES: InspectorAppDeviceType[] = [
  "fill",
  "mobile",
  "tablet",
  "desktop",
  "custom",
];
const DISPLAY_MODES: InspectorAppDisplayMode[] = [
  "inline",
  "pip",
  "fullscreen",
];

// --- ui_ask_user argument bounds ---------------------------------------
//
// The question and its labels are rendered verbatim in the user's thread, so
// they're bounded here rather than trusted. Both caps are generous for a real
// clarifying question and small enough that a runaway generation can't paint
// a wall of text into the conversation.
const MAX_QUESTION_CHARS = 300;
const MAX_OPTION_LABEL_CHARS = 80;
// The answer token echoed back to the model. Bounded for the same reason the
// label is: it is model-supplied, it lands in the transcript, and the schema
// describes it as short. Downstream serialization is already budgeted
// (`okResult`), so this is about keeping the contract honest rather than
// preventing a hang.
const MAX_OPTION_VALUE_CHARS = 120;
const MIN_ASK_OPTIONS = 2;
const MAX_ASK_OPTIONS = 4;

/**
 * Normalize the model's `options` into distinct, renderable choices.
 *
 * Tolerant about SHAPE (a bare string is accepted as its own label and
 * value — a cheap, lossless reading of the most likely schema slip), strict
 * about COUNT: fewer than two choices isn't a question, and more than four
 * is a contract violation the model should fix rather than have silently
 * truncated behind its back.
 *
 * Duplicates collapse on BOTH fields, for two different reasons that both
 * amount to "that isn't a choice": two identical values are indistinguishable
 * to the model, and two identical labels are indistinguishable to the user.
 * Labels are compared AFTER truncation, since that is what actually gets
 * painted — two long labels differing only past the cut render as one button.
 */
function parseAskUserOptions(
  raw: unknown,
): { ok: true; options: AskUserOption[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) {
    return {
      ok: false,
      error: `'options' must be an array of ${MIN_ASK_OPTIONS}-${MAX_ASK_OPTIONS} choices.`,
    };
  }
  if (raw.length > MAX_ASK_OPTIONS) {
    return {
      ok: false,
      error: `'options' must contain at most ${MAX_ASK_OPTIONS} choices (got ${raw.length}). Ask a narrower question.`,
    };
  }
  const options: AskUserOption[] = [];
  const seenValues = new Set<string>();
  const seenLabels = new Set<string>();
  for (const entry of raw) {
    let label: string | undefined;
    let value: string | undefined;
    if (typeof entry === "string") {
      label = asOptionalString(entry);
      value = label;
    } else if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const record = entry as Record<string, unknown>;
      label = asOptionalString(record.label);
      // `value` is optional: the label is a fine answer token when the model
      // doesn't supply a separate one.
      value = asOptionalString(record.value) ?? label;
    }
    if (!label || !value) continue;
    // REJECT rather than truncate. The value is the token handed back to the
    // model, so trimming it invents a different answer than the one offered —
    // and two values differing only past the cut would collapse into a false
    // duplicate. The label is the opposite case: it is display text, where a
    // clean ellipsis is better than an error.
    if (value.length > MAX_OPTION_VALUE_CHARS) {
      return {
        ok: false,
        error: `'options[].value' must be ${MAX_OPTION_VALUE_CHARS} characters or fewer — it is an answer token, not prose.`,
      };
    }
    const displayLabel =
      label.length > MAX_OPTION_LABEL_CHARS
        ? `${label.slice(0, MAX_OPTION_LABEL_CHARS - 1)}…`
        : label;
    if (seenValues.has(value)) continue;
    if (seenLabels.has(displayLabel)) continue;
    seenValues.add(value);
    seenLabels.add(displayLabel);
    options.push({ label: displayLabel, value });
  }
  if (options.length < MIN_ASK_OPTIONS) {
    return {
      ok: false,
      error: `'options' must contain at least ${MIN_ASK_OPTIONS} distinct choices, each with a non-empty label.`,
    };
  }
  return { ok: true, options };
}

export function buildCoreUiTools(): UiToolDefinition[] {
  return [
    {
      name: "ui_navigate",
      description:
        `Navigate the MCPJam inspector to a page. The user sees the page change. Valid targets: ${listUiNavigationTargets().join(", ")}. ` +
        "Deep paths like 'evals/suite/<suiteId>' are allowed.",
      inputSchema: {
        type: "object",
        properties: {
          target: {
            type: "string",
            description:
              "Page to open: a tab name (e.g. 'playground') or deep path (e.g. 'evals/suite/<id>').",
          },
        },
        required: ["target"],
        additionalProperties: false,
      },
      readOnly: false,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        // NOT idempotent: a normal navigation pushes a browser-history entry
        // even when the destination is unchanged, so repeated calls DO have
        // an additional effect. Advertising idempotent would invite a native
        // agent to retry freely and pile up history.
        idempotentHint: false,
        openWorldHint: false,
      },
      mayNavigate: true,
      execute: async (args) => {
        const target = asOptionalString(args.target);
        if (!target) return errorResult("Missing required 'target' string.");
        return fromActionResult(await navigateAction(target));
      },
    },
    {
      name: "ui_select_server",
      description:
        "Select a connected MCP server in the MCPJam inspector by name, making it the focused server for the tools/resources views. Fails if the server is unknown or disconnected.",
      inputSchema: {
        type: "object",
        properties: {
          serverName: { type: "string", description: "Server name to focus." },
        },
        required: ["serverName"],
        additionalProperties: false,
      },
      readOnly: false,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      execute: async (args) => {
        const serverName = asOptionalString(args.serverName);
        if (!serverName) {
          return errorResult("Missing required 'serverName' string.");
        }
        return fromActionResult(await selectServerAction(serverName));
      },
    },
    {
      name: "ui_set_app_context",
      description:
        "Change the MCPJam playground's emulated app context: theme (light/dark), device type, widget display mode, locale, or time zone. The user sees the change immediately.",
      inputSchema: {
        type: "object",
        properties: {
          theme: { type: "string", enum: ["light", "dark"] },
          deviceType: {
            type: "string",
            enum: DEVICE_TYPES,
            description:
              "'fill' = the default, fits the panel; the rest are fixed-size presets.",
          },
          displayMode: { type: "string", enum: DISPLAY_MODES },
          locale: {
            type: "string",
            description: "BCP 47 locale, e.g. 'en-US'.",
          },
          timeZone: {
            type: "string",
            description: "IANA time zone, e.g. 'Europe/Paris'.",
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
      // Auto-opens the playground when its handler isn't mounted — from a
      // non-playground route that is a navigation.
      mayNavigate: true,
      execute: async (args) => {
        const payload: SetAppContextInspectorCommand["payload"] = {};
        const theme = asOptionalString(args.theme);
        if (theme === "light" || theme === "dark") payload.theme = theme;
        const deviceType = asOptionalString(args.deviceType);
        if (DEVICE_TYPES.includes(deviceType as InspectorAppDeviceType)) {
          payload.deviceType = deviceType as InspectorAppDeviceType;
        }
        const displayMode = asOptionalString(args.displayMode);
        if (DISPLAY_MODES.includes(displayMode as InspectorAppDisplayMode)) {
          payload.displayMode = displayMode as InspectorAppDisplayMode;
        }
        const locale = asOptionalString(args.locale);
        if (locale) payload.locale = locale;
        const timeZone = asOptionalString(args.timeZone);
        if (timeZone) payload.timeZone = timeZone;
        if (Object.keys(payload).length === 0) {
          return errorResult(
            "Provide at least one of: theme, deviceType, displayMode, locale, timeZone.",
          );
        }
        const notOpen = await ensurePlaygroundOpen("setAppContext");
        if (notOpen) return notOpen;
        const response = await dispatchInspectorCommand({
          type: "setAppContext",
          payload,
        });
        return fromActionResult(commandResponseToActionResult(response));
      },
    },
    {
      name: "ui_snapshot_app",
      description:
        "Read what the user currently sees — the open screen, the servers they have selected and their connection status, plus the detailed state of any screen that reports it (e.g. the Playground's selected tool, form values, and last result). Changes nothing. Use it to observe before acting. Pass 'surface' to read one screen; omit it for the whole app.",
      inputSchema: {
        type: "object",
        properties: {
          surface: {
            type: "string",
            description:
              "Optional screen id to read on its own, e.g. 'playground'. Omit for the whole app.",
          },
        },
        additionalProperties: false,
      },
      readOnly: true,
      // Read-only: never gates, in either approval mode. That exemption is
      // only sound because it observes whatever is already open and never
      // mounts a surface to read it.
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      execute: async (args) => {
        const surface = asOptionalString(args.surface);
        const response = await dispatchInspectorCommand({
          type: "snapshotApp",
          payload: surface ? { surface: surface as never } : {},
        });
        return fromActionResult(commandResponseToActionResult(response));
      },
    },
    {
      name: ASK_USER_TOOL_NAME,
      description:
        "Ask the user one short multiple-choice question and wait for their answer. Use ONLY when the request is genuinely ambiguous AND the readings lead to materially different actions; if one reading dominates, act on it and say what you assumed. Never ask what ui_snapshot_app or the message's UI context already answers. Read (docs, snapshots) before asking so the choices are good; never change anything before asking. The user can always answer in their own words instead of choosing.",
      inputSchema: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description:
              "The single question to ask, in plain language. Max 300 characters.",
          },
          options: {
            type: "array",
            minItems: MIN_ASK_OPTIONS,
            maxItems: MAX_ASK_OPTIONS,
            items: {
              type: "object",
              properties: {
                label: {
                  type: "string",
                  description:
                    "What the user sees. Phrase it as their goal ('Connect to a local MCP server'), not an internal noun.",
                },
                value: {
                  type: "string",
                  description:
                    "Short token returned to you when this is chosen. Defaults to the label.",
                },
              },
              required: ["label"],
              additionalProperties: false,
            },
            description:
              "2-4 mutually exclusive choices. A free-text answer is always offered — do not add an 'Other'/'Something else' option yourself.",
          },
        },
        required: ["question", "options"],
        additionalProperties: false,
      },
      // Asking changes nothing. Read-only means it never gates behind the
      // approval pill — a confirmation click on a question would be a click
      // to permit a click.
      readOnly: true,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        // NOT idempotent: each call paints a new card and demands the user's
        // attention. A native agent retrying freely would nag.
        idempotentHint: false,
        openWorldHint: false,
      },
      execute: async (args, ctx) => {
        // The card resolves the parked promise by tool-call id, so a call
        // that arrived without one can never be answered — fail it now
        // rather than hang the stream.
        const toolCallId = ctx?.toolCallId;
        if (!toolCallId) {
          return errorResult("ui_ask_user is unavailable in this context.");
        }
        const question = asOptionalString(args.question);
        if (!question)
          return errorResult("Missing required 'question' string.");
        if (question.length > MAX_QUESTION_CHARS) {
          return errorResult(
            `'question' must be ${MAX_QUESTION_CHARS} characters or fewer.`,
          );
        }
        const parsed = parseAskUserOptions(args.options);
        if (!parsed.ok) return errorResult(parsed.error);

        const answer = await registerAskUserQuestion({
          toolCallId,
          question,
          options: parsed.options,
          ...(ctx?.scope !== undefined ? { scope: ctx.scope } : {}),
        });

        // A dismissal is a normal outcome, NOT an error: the user moved on,
        // which is information. Returning isError would invite the model to
        // retry the question — the one response that's certainly wrong.
        //
        // The note tells the model to STOP, not to press on. The turn is not
        // resumed off a dismissal (`shouldAutoResumeTurn`), so this text is
        // read on the user's NEXT message — where "continue with your best
        // interpretation" would mean answering the request they abandoned.
        if (answer.kind === "dismissed") {
          return okResult({
            kind: "dismissed",
            note: "The user did not answer and moved on. Do not ask this again, and do not answer the original request from a guess — respond to whatever they say next.",
          });
        }
        return okResult(answer);
      },
    },
  ];
}
