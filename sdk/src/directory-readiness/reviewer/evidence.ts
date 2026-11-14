/**
 * The reviewer path: checks MCPJam runs as a directory's reviewer, on the
 * account a reviewer sign-in connected, and on no other account.
 *
 * Here: what a submission's reviewer section asks those checks to do, and
 * what they gathered. The answers name a read-only tool rather than a value,
 * so every check is a call the submitter chose and any run can repeat.
 *
 * Pure. Safe from the browser entry.
 */

import type {
  DirectoryAnswer,
  DirectoryFlow,
  DirectoryFlowField,
} from "../flows/types.js";

/** A flow's reviewer section, by name after its step's prefix. */
export const DIRECTORY_REVIEWER_FIELDS = [
  "identityTool",
  "identityArgs",
  "expectedIdentityPath",
  "expectedIdentity",
  "expectedOrganizationPath",
  "expectedOrganization",
  "fixtures",
] as const;

/**
 * The fixtures field's rows: the resource, and its lookup as
 * `tool {"json": "arguments"}`. MCPJam's own list, not a portal's fixed
 * rows, so it grows as it fills.
 */
export const DIRECTORY_REVIEWER_FIXTURE_PAIRS: NonNullable<
  DirectoryFlowField["pairs"]
> = {
  columns: ["Resource", "Lookup"],
  keys: ["fixture", "lookup"],
  placeholders: [["Sample Project", 'get_project {"name": "Sample Project"}']],
  maxRows: 20,
  grow: true,
};

export interface DirectoryReviewerIdentitySpec {
  tool: string;
  /** Fixed, so the call is the same on every run. */
  arguments: Record<string, unknown>;
  /** JSON paths into the tool's result, such as `$.user.email`. */
  identityPath?: string;
  expectedIdentity?: string;
  organizationPath?: string;
  expectedOrganization?: string;
}

/** A resource the instructions or cases name, and the read-only call that finds it. */
export interface DirectoryReviewerFixture {
  name: string;
  tool: string;
  arguments: Record<string, unknown>;
  /** Why its row cannot be used, when it cannot. */
  problem?: string;
}

/** Reviewer instructions or one test case: text a fixture's name may appear in. */
export interface DirectoryReviewerCase {
  label: string;
  text: string;
}

export interface DirectoryReviewerSpec {
  /** Absent: no identity tool named. A string: why the answers cannot be used. */
  identity?: DirectoryReviewerIdentitySpec | string;
  fixtures: DirectoryReviewerFixture[];
  cases: DirectoryReviewerCase[];
}

/** A call made as the reviewer. Never the result's body: only what it named. */
export interface DirectoryReviewerCall {
  tool: string;
  arguments: Record<string, unknown>;
  error?: string;
}

export interface DirectoryReviewerIdentityEvidence {
  outcome: "verified" | "wrong-account" | "wrong-tenant" | "unverified";
  /** Why it is not verified. */
  reason?: string;
  call?: DirectoryReviewerCall;
  observed?: { identity?: string; organization?: string };
  expected?: { identity?: string; organization?: string };
}

export interface DirectoryReviewerFixtureResult {
  name: string;
  tool: string;
  status: "found" | "missing" | "unchecked";
  reason?: string;
}

export interface DirectoryReviewerFixtureEvidence {
  /** Why nothing was looked up, when nothing was. */
  blocked?: string;
  fixtures: DirectoryReviewerFixtureResult[];
  /** The cases that name a fixture the lookup did not find. */
  blockedCases: Array<{ case: string; fixtures: string[] }>;
}

export interface DirectoryReviewerPathEvidence {
  /** The reviewer account the checks ran on, or why the run had none. */
  account: { id: string } | { missing: string };
  identity?: DirectoryReviewerIdentityEvidence;
  fixtures?: DirectoryReviewerFixtureEvidence;
}

/** MCPJam's own client, then two that edges commonly treat differently. */
export const DIRECTORY_CLIENT_SIGNATURES: ReadonlyArray<{
  id: string;
  label: string;
  /** Absent: the run's transport sends what it always sends. */
  userAgent?: string;
}> = [
  { id: "mcpjam", label: "MCPJam's own client" },
  {
    id: "browser",
    label: "a web browser",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  },
  {
    id: "http-library",
    label: "Python's HTTP library",
    userAgent: "Python-urllib/3.12",
  },
];

export interface DirectoryClientSignatureProbe {
  signature: string;
  document: "protected-resource" | "authorization-server";
  url: string;
  /** 0 when nothing answered. */
  status: number;
  /** A refusal's first 2,000 characters, or why nothing answered. */
  body?: string;
}

export interface DirectoryClientSignatureEvidence {
  probes: DirectoryClientSignatureProbe[];
}

/** What a submission run brings to an engine's grade, beside the server's evidence. */
export interface DirectoryReviewerRunInput {
  /** Absent for a run that grades no submission. */
  reviewerPath?: DirectoryReviewerPathEvidence;
  clientSignatures?: DirectoryClientSignatureEvidence;
}

/** The step a flow keeps its reviewer section on: the one with `<step>.identityTool`. */
export function directoryReviewerStep(flow: DirectoryFlow): string | undefined {
  return flow.steps.find((step) =>
    step.fields.some((field) => field.key === `${step.id}.identityTool`)
  )?.id;
}

/** What a submission's answers ask the reviewer path to check. */
export function directoryReviewerSpec(
  flow: DirectoryFlow,
  answers: readonly DirectoryAnswer[]
): DirectoryReviewerSpec {
  const step = directoryReviewerStep(flow);
  const own = new Set(
    DIRECTORY_REVIEWER_FIELDS.map((name) => `${step}.${name}`)
  );
  const valueOf = (key: string) => answers.find((a) => a.key === key)?.value;
  const text = (name: (typeof DIRECTORY_REVIEWER_FIELDS)[number]) => {
    const value = valueOf(`${step}.${name}`);
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  };
  const tool = text("identityTool");
  const args = jsonObject(text("identityArgs"));
  const lookups = valueOf(`${step}.fixtures`);
  return {
    identity: !tool
      ? undefined
      : !args
        ? "the identity tool's arguments are not a JSON object"
        : {
            tool,
            arguments: args,
            identityPath: text("expectedIdentityPath"),
            expectedIdentity: text("expectedIdentity"),
            organizationPath: text("expectedOrganizationPath"),
            expectedOrganization: text("expectedOrganization"),
          },
    fixtures: (Array.isArray(lookups) ? lookups : []).flatMap(fixtureFrom),
    cases: flow.steps.flatMap((entry) =>
      entry.fields.flatMap((field) =>
        own.has(field.key)
          ? []
          : casesOf(field, valueOf(field.key), field.key.startsWith(`${step}.`))
      )
    ),
  };
}

/** A fixture row: the resource, and its lookup written as `tool {"json": "arguments"}`. */
function fixtureFrom(row: unknown): DirectoryReviewerFixture[] {
  if (typeof row !== "object" || row === null) return [];
  const { fixture, lookup } = row as Record<string, unknown>;
  if (typeof fixture !== "string" || !fixture.trim()) return [];
  const [, tool = "", rest = ""] =
    /^\s*(\S+)\s*(.*)$/s.exec(typeof lookup === "string" ? lookup : "") ?? [];
  const args = jsonObject(rest.trim() || undefined);
  return [
    {
      name: fixture.trim(),
      tool,
      arguments: args ?? {},
      ...(!tool
        ? { problem: "its lookup names no tool" }
        : !args
          ? { problem: "its lookup's arguments are not a JSON object" }
          : {}),
    },
  ];
}

/** Rows anywhere in the flow, and the reviewer section's longer text. */
function casesOf(
  field: DirectoryFlowField,
  value: unknown,
  inReviewerStep: boolean
): DirectoryReviewerCase[] {
  if (Array.isArray(value) && ["pairs", "rows"].includes(field.control)) {
    return value.map((row: unknown, index) => ({
      label: `${field.label} ${index + 1}`,
      text: typeof row === "object" && row ? Object.values(row).join(" ") : "",
    }));
  }
  return inReviewerStep &&
    field.control === "textarea" &&
    typeof value === "string"
    ? [{ label: field.label, text: value }]
    : [];
}

/** `{}` for no text; `undefined` for text that is not one JSON object. */
function jsonObject(
  text: string | undefined
): Record<string, unknown> | undefined {
  if (text === undefined) return {};
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    // Not JSON: the caller reports the answer as unusable.
    return undefined;
  }
}
