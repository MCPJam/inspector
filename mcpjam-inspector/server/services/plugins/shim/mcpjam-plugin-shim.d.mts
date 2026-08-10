/**
 * Types for the shim's exported seam, so TypeScript callers (the unit tests)
 * can import it without `allowJs`.
 *
 * Declarations only — never uploaded to a sandbox, and never a second source of
 * truth: the tests exercise the real `.mjs`, so a signature that drifts from
 * this file fails at runtime rather than passing quietly.
 */

export declare class ShimConfigError extends Error {}

export interface ShimLaunchSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
}

export interface ShimConfig {
  port: number;
  host: string;
  token: string;
  launch: ShimLaunchSpec;
  maxSessions: number;
  sessionIdleMs: number;
  requestTimeoutMs: number;
}

export interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  error: { code: number; message: string };
}

export type ClientMessageKind =
  | "request"
  | "notification"
  | "unsupported"
  | "invalid";

export declare function parseLaunchSpec(raw: unknown): ShimLaunchSpec;

export declare function parseShimConfig(
  env: Record<string, string | undefined>
): ShimConfig;

export declare function drainFramedLines(buffer: string): {
  lines: string[];
  rest: string;
};

export declare function jsonRpcError(
  id: string | number | null | undefined,
  code: number,
  message: string
): JsonRpcErrorResponse;

export declare function classifyClientMessage(
  message: unknown
): ClientMessageKind;

export declare function constantTimeEquals(a: string, b: string): boolean;
