import type { ElementLocator, InteractAction } from "../contract/steps.js";
import type { PlatformWidgetSnapshot } from "./types.js";

/** A retained browser exists only in the local Inspector that created it. */
export interface PlatformWidgetSessionTarget {
  projectId: string;
  serverId: string;
  sessionId: string;
}

export interface PlatformWidgetViewport {
  width: number;
  height: number;
}

export interface PlatformWidgetRequest {
  toolName: string;
  parameters?: Record<string, unknown>;
  injectOpenAiCompat?: boolean;
  viewport?: PlatformWidgetViewport;
}

export interface PlatformWidgetSessionCreateBody extends PlatformWidgetRequest {
  clientCapabilities?: Record<string, unknown>;
}

export interface PlatformWidgetRenderBody extends PlatformWidgetRequest {
  includeSnapshot?: boolean;
  includeScreenshot?: boolean;
}

/** Render failures have no session ID; successful renders retain one browser. */
export interface PlatformWidgetSessionCreated {
  status: string;
  elapsedMs: number;
  sessionId?: string;
  serverId?: string;
  mountedWidgetId?: string;
  viewport?: PlatformWidgetViewport;
  createdAt?: number;
  expiresAt?: number;
  idleTimeoutMs?: number;
  resourceUri?: string;
  bridgeInitialized?: boolean;
  screenshotBase64?: string;
  consoleErrors?: string[];
  blockedRequests?: string[];
  hint?: string;
}

export interface PlatformWidgetAction {
  action:
    | "screenshot"
    | "left_click"
    | "double_click"
    | "right_click"
    | "mouse_move"
    | "type"
    | "key"
    | "scroll"
    | "wait";
  coordinate?: [number, number];
  text?: string;
  scrollDirection?: "up" | "down" | "left" | "right";
  scrollAmount?: number;
  duration?: number;
}

export interface PlatformWidgetToolCall {
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
  elapsedMs: number;
  error?: string;
  result?: unknown;
  visibility?: Array<"model" | "app">;
}

export interface PlatformWidgetSessionActionResult {
  action: PlatformWidgetAction;
  widgetToolCalls: PlatformWidgetToolCall[];
  elapsedMs: number;
  expiresAt: number;
  screenshotBase64?: string;
  note?: string;
  pluginWorkspace?: Record<string, unknown>;
}

export interface PlatformWidgetSessionSnapshot {
  snapshot: PlatformWidgetSnapshot;
  expiresAt: number;
}

/** Assertions use the retained-session wire's `type` discriminator. */
export type PlatformWidgetSessionAssertion =
  | { type: "textVisible"; text: string }
  | { type: "elementVisible" | "elementHidden"; target: ElementLocator }
  | { type: "inputValue"; target: ElementLocator; equals: string }
  | { type: "widgetToolCalled"; toolName: string };

export type PlatformWidgetSessionStep =
  | InteractAction
  | { kind: "assert"; assertion: PlatformWidgetSessionAssertion };

export interface PlatformWidgetSessionStepBody {
  step: PlatformWidgetSessionStep;
  priorWidgetToolCalls?: PlatformWidgetToolCall[];
}

export interface PlatformWidgetSessionStepResult {
  step: PlatformWidgetSessionStep;
  ok: boolean;
  widgetToolCalls: PlatformWidgetToolCall[];
  followUps: string[];
  elapsedMs: number;
  expiresAt: number;
  reason?: string;
  screenshotBase64?: string;
  note?: string;
  pluginWorkspace?: Record<string, unknown>;
}

export interface PlatformWidgetSessionClosed {
  closed: boolean;
}

export function widgetSessionPath(target: PlatformWidgetSessionTarget): string {
  return `/projects/${encodeURIComponent(target.projectId)}/servers/${encodeURIComponent(target.serverId)}/widget-sessions/${encodeURIComponent(target.sessionId)}`;
}
