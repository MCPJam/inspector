/**
 * Core app-wide UI tools: navigation, server focus, emulated app context,
 * and the whole-app snapshot. Registered globally (never surface-scoped) —
 * they are how the agent moves BETWEEN surfaces, so they must exist on all
 * of them.
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
} from "./shared";

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
      // The only read-only tool in the catalog: never gates, in either
      // approval mode. That exemption is only sound because it observes
      // whatever is already open and never mounts a surface to read it.
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
  ];
}
