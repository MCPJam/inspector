/** Session edit buffer; PreparedEvalServerPage persists reviews in Convex. */

import {
  DEFAULT_FIRST_RUN_ITERATIONS,
  DEFAULT_FIRST_RUN_CLIENTS,
  type FirstRunClient,
  type PreviewCase,
  type PreviewSuite,
} from "./eval-server-preview-model";

export const EVAL_SERVER_PREVIEW_DRAFT_VERSION = 1;

export type EvalServerPreviewStep = "suites" | "confirm";

export type EvalServerPreviewDraft = {
  version: typeof EVAL_SERVER_PREVIEW_DRAFT_VERSION;
  serverId: string;
  generationHash?: string;
  chatHistory?: Array<{ id: number; role: "assistant" | "user"; text: string }>;
  suites: PreviewSuite[];
  openSuiteIds: string[];
  step: EvalServerPreviewStep;
  clients: FirstRunClient[];
  iterationsPerCase: number;
};

export function evalServerPreviewStorageKey(serverId: string): string {
  return `mcpjam.eval-server-preview.${serverId}`;
}

export function readEvalServerPreviewDraft(
  serverId: string,
): EvalServerPreviewDraft | null {
  if (typeof sessionStorage === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(evalServerPreviewStorageKey(serverId));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return parseDraft(parsed, serverId);
  } catch {
    return null;
  }
}

export function writeEvalServerPreviewDraft(
  serverId: string,
  draft: Omit<EvalServerPreviewDraft, "version" | "serverId">,
): void {
  if (typeof sessionStorage === "undefined") return;
  try {
    const payload: EvalServerPreviewDraft = {
      version: EVAL_SERVER_PREVIEW_DRAFT_VERSION,
      serverId,
      ...draft,
    };
    sessionStorage.setItem(
      evalServerPreviewStorageKey(serverId),
      JSON.stringify(payload),
    );
  } catch {
    // Quota or private mode. The in-memory page state still works.
  }
}

export function clearEvalServerPreviewDraft(serverId: string): void {
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.removeItem(evalServerPreviewStorageKey(serverId));
  } catch {
    // Ignore.
  }
}

function parseDraft(
  value: unknown,
  serverId: string,
): EvalServerPreviewDraft | null {
  if (!value || typeof value !== "object") return null;
  const entry = value as Partial<EvalServerPreviewDraft>;
  if (entry.version !== EVAL_SERVER_PREVIEW_DRAFT_VERSION) return null;
  if (entry.serverId !== serverId) return null;
  if (!Array.isArray(entry.suites) || !entry.suites.every(isPreviewSuite)) {
    return null;
  }
  if (
    !Array.isArray(entry.openSuiteIds) ||
    !entry.openSuiteIds.every((id) => typeof id === "string")
  ) {
    return null;
  }
  if (entry.step !== "suites" && entry.step !== "confirm") return null;
  const clients = Array.isArray(entry.clients)
    ? entry.clients.filter(isClient)
    : [...DEFAULT_FIRST_RUN_CLIENTS];
  const iterationsPerCase =
    typeof entry.iterationsPerCase === "number" &&
    Number.isFinite(entry.iterationsPerCase)
      ? Math.min(10, Math.max(1, Math.trunc(entry.iterationsPerCase)))
      : DEFAULT_FIRST_RUN_ITERATIONS;

  return {
    version: EVAL_SERVER_PREVIEW_DRAFT_VERSION,
    serverId,
    ...(typeof entry.generationHash === "string"
      ? { generationHash: entry.generationHash }
      : {}),
    ...(Array.isArray(entry.chatHistory)
      ? {
          chatHistory: entry.chatHistory.filter(
            (message) =>
              message &&
              typeof message.id === "number" &&
              (message.role === "user" || message.role === "assistant") &&
              typeof message.text === "string",
          ),
        }
      : {}),
    suites: entry.suites,
    openSuiteIds: entry.openSuiteIds,
    step: entry.step,
    clients,
    iterationsPerCase,
  };
}

function isPreviewSuite(value: unknown): value is PreviewSuite {
  if (!value || typeof value !== "object") return false;
  const suite = value as PreviewSuite;
  return (
    typeof suite.id === "string" &&
    typeof suite.title === "string" &&
    typeof suite.description === "string" &&
    Array.isArray(suite.cases) &&
    suite.cases.every(isPreviewCase)
  );
}

function isPreviewCase(value: unknown): value is PreviewCase {
  if (!value || typeof value !== "object") return false;
  const previewCase = value as PreviewCase;
  return (
    typeof previewCase.id === "string" && typeof previewCase.title === "string"
  );
}

function isClient(value: unknown): value is FirstRunClient {
  if (!value || typeof value !== "object") return false;
  const client = value as FirstRunClient;
  return typeof client.id === "string" && typeof client.name === "string";
}
