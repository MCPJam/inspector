/**
 * First-run preview after "Eval my server".
 *
 * Shared review shape populated by background generation.
 * `buildEvalServerPreview` remains an explicit test fixture only; production
 * pages load saved preparation records and never fall back to this data.
 */

import type { CasePredicates, EvalMatchOptions } from "@/shared/eval-matching";
import type { TestStep } from "@/shared/steps";
import { writeSimpleCase } from "./simple-case/simple-case-model";

export type PreviewCase = {
  requiresSetup?: boolean;
  selected?: boolean;
  id: string;
  title: string;
  /** Filled once the user opens today's case editor. */
  prompt?: string;
  expectedOutput?: string;
  steps?: TestStep[];
  matchOptions?: EvalMatchOptions;
  predicates?: CasePredicates;
};

export type PreviewSuite = {
  id: string;
  title: string;
  description: string;
  cases: PreviewCase[];
  /** User-added empty container. Cases come from Add cases. */
  draft?: boolean;
};

/** Exploratory first-run default. Later runs can raise this. */
export const DEFAULT_FIRST_RUN_ITERATIONS = 1;

export type PreviewFindingSeverity = "info" | "warning";

export type PreviewFinding = {
  id: string;
  title: string;
  body: string;
  /** Where this came from. Discovery vs the connection itself. */
  source: "discovery" | "connection";
  /** ErrorCard severity. Findings are info or warning, not errors. */
  severity: PreviewFindingSeverity;
};

export const DEFAULT_FIRST_RUN_CLIENTS = [
  { id: "chatgpt", name: "ChatGPT" },
  { id: "claude", name: "Claude" },
] as const;

export const ADDABLE_FIRST_RUN_CLIENTS = [
  { id: "cursor", name: "Cursor" },
  { id: "vscode", name: "VS Code" },
  { id: "claude-code", name: "Claude Code" },
  { id: "gemini", name: "Gemini" },
] as const;

export type FirstRunClient = {
  id: string;
  name: string;
};

export function createDraftPreviewSuite(): PreviewSuite {
  // Opaque, not the current count: deleting a middle suite and adding another
  // would otherwise mint an id a surviving row already carries.
  return {
    id: `draft:suite-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    title: "New suite",
    description: "Add cases to this suite.",
    cases: [],
    draft: true,
  };
}

export function createDraftPreviewCase(title = "New case"): PreviewCase {
  return {
    id: `draft:case-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    title,
    prompt: "",
    expectedOutput: "",
    steps: writeSimpleCase([], { prompt: "", tools: [], noTool: false }),
  };
}

export function hydratePreviewCase(previewCase: PreviewCase): PreviewCase {
  const prompt = previewCase.prompt ?? previewCase.title;
  return {
    ...previewCase,
    prompt,
    expectedOutput: previewCase.expectedOutput ?? "",
    steps:
      previewCase.steps ??
      writeSimpleCase([], { prompt, tools: [], noTool: false }),
  };
}

export function isEvalServerPreviewId(id: string): boolean {
  return id.startsWith("preview:") || id.startsWith("draft:");
}

export function findPreviewCase(
  suites: PreviewSuite[],
  suiteId: string,
  caseId: string,
): PreviewCase | null {
  const suite = suites.find((entry) => entry.id === suiteId);
  return suite?.cases.find((entry) => entry.id === caseId) ?? null;
}

export function addPreviewCase(
  suites: PreviewSuite[],
  suiteId: string,
  previewCase: PreviewCase,
): PreviewSuite[] {
  return suites.map((suite) =>
    suite.id === suiteId
      ? { ...suite, cases: [...suite.cases, previewCase] }
      : suite,
  );
}

export function updatePreviewCase(
  suites: PreviewSuite[],
  suiteId: string,
  caseId: string,
  patch: Partial<PreviewCase>,
): PreviewSuite[] {
  return suites.map((suite) =>
    suite.id === suiteId
      ? {
          ...suite,
          cases: suite.cases.map((entry) =>
            entry.id === caseId ? { ...entry, ...patch } : entry,
          ),
        }
      : suite,
  );
}

export function removePreviewSuite(
  suites: PreviewSuite[],
  suiteId: string,
): PreviewSuite[] {
  return suites.filter((suite) => suite.id !== suiteId);
}

export function removePreviewCase(
  suites: PreviewSuite[],
  suiteId: string,
  caseId: string,
): PreviewSuite[] {
  return suites.map((suite) =>
    suite.id === suiteId
      ? { ...suite, cases: suite.cases.filter((entry) => entry.id !== caseId) }
      : suite,
  );
}

export type EvalServerPreview = {
  serverId: string;
  serverName: string;
  suites: PreviewSuite[];
  findings: PreviewFinding[];
};

export function previewCaseCount(preview: EvalServerPreview): number {
  return preview.suites.reduce((sum, suite) => sum + suite.cases.length, 0);
}

export function buildEvalServerPreview(server: {
  id: string;
  name: string;
}): EvalServerPreview {
  const slug = slugFor(server.name);
  return {
    serverId: server.id,
    serverName: server.name,
    suites: [
      {
        id: `preview:${slug}:create-and-assign`,
        title: "Create and assign work",
        description:
          "Create a task, assign it, set a due date, comment. The path users actually take.",
        cases: [
          { id: "case-create-task", title: "Create a task from a short brief" },
          { id: "case-assign", title: "Assign the task to a teammate" },
          { id: "case-due-date", title: "Set a due date on the new task" },
          { id: "case-comment", title: "Leave a comment on the task" },
          {
            id: "case-full-path",
            title: "Create, assign, date, and comment in one pass",
          },
          { id: "case-empty-title", title: "Refuse a task with no title" },
        ],
      },
      {
        id: `preview:${slug}:permissions`,
        title: "Permissions and workspace",
        description:
          "Guest cannot assign. Private project stays private. Workspace switch does not leak.",
        cases: [
          { id: "case-guest-assign", title: "Guest cannot assign work" },
          { id: "case-private", title: "Private project stays private" },
          {
            id: "case-workspace-switch",
            title: "Workspace switch does not leak",
          },
          { id: "case-role-change", title: "Revoked role loses write access" },
        ],
      },
      {
        id: `preview:${slug}:search`,
        title: "Search and retrieve",
        description:
          "Find a task by title, open it, read comments. Ranking matters when the workspace is large.",
        cases: [
          { id: "case-find-title", title: "Find a task by title" },
          { id: "case-open", title: "Open the matched task" },
          { id: "case-read-comments", title: "Read comments on the task" },
          {
            id: "case-ranking",
            title: "Best match ranks first in a large workspace",
          },
          { id: "case-missing", title: "Missing title returns a clear miss" },
        ],
      },
    ],
    findings: [
      {
        id: "finding-deprecated-tools",
        source: "discovery",
        severity: "warning",
        title: "Deprecated tools still advertised",
        body: "Detected from the server's own description prose: diagram_create_mermaid, create_attachment, notion-query-data-sources, and notion-search-agents. Name collisions and shadowing showed up in the same pass.",
      },
      {
        id: "finding-token-ttl",
        source: "connection",
        severity: "info",
        title: "Access tokens expire after 1 hour",
        body: `${server.name} issues an access token that lasts 1 hour. An agent task running longer than that can lose the connection partway through, and the agent will usually report it as a missing connection rather than an expired login.`,
      },
    ],
  };
}

function slugFor(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return slug || "server";
}
