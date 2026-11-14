/**
 * Directory flows: one directory's submission form as data.
 *
 * A flow is the portal copied field by field — labels, limits, defaults and
 * the portal's own error lines — plus where each engine check's result
 * belongs in it. The page, the API, the CLI and the agent tools all read the
 * same definition, so a portal change is one data edit rather than four.
 *
 * Pure data. Safe from the browser entry.
 */

import type { DirectoryReadinessFinding } from "../types.js";

/** Flows that exist. The backend validates its own list; this one names data. */
export const DIRECTORY_FLOW_IDS = [
  "claude-connector",
  "chatgpt-plugin",
] as const;

export type DirectoryFlowId = (typeof DIRECTORY_FLOW_IDS)[number];

/** What a portal field can hold. Records are rows of a `pairs` field. */
export type DirectoryAnswerValue =
  string | number | boolean | null | string[] | Array<Record<string, string>>;

/**
 * Where an answer came from. Only `set` and `confirmed` mean someone stood
 * behind it: `default` is the portal's own preselection (derived from the
 * flow, never stored), `account` was filled from the signed-in account,
 * `imported` came from a draft or a package, and `reset` is a value a
 * reconnect put back.
 */
export type DirectoryAnswerOrigin =
  "default" | "account" | "set" | "confirmed" | "imported" | "reset";

export interface DirectoryAnswer {
  key: string;
  value: DirectoryAnswerValue;
  origin: DirectoryAnswerOrigin;
  /** The signed-in principal that wrote it. */
  setBy?: string;
  /** What an agent says it is. Display only, never authorization. */
  setByLabel?: string;
  setVia?: "web" | "api" | "cli" | "mcp" | "agent";
  setAt?: number;
  /** Submission revision at which this answer was last written. */
  revision?: number;
  /** The field's wording revision when it was written or confirmed. */
  wordingRevision?: string;
}

export interface DirectoryFlowOption {
  value: string;
  label: string;
  help?: string;
}

export type DirectoryFieldControl =
  | "text"
  | "textarea"
  | "select"
  | "multi-select"
  | "radio"
  | "radio-cards"
  | "checkbox"
  | "checkbox-group"
  | "pairs"
  /** Records a package supplies, such as test cases; any string columns. */
  | "rows"
  | "server"
  /** The NAME of a project secret. The answer never holds the value. */
  | "secret";

export type DirectoryFieldFormat =
  "https-url" | "url" | "email" | "url-or-email" | "slug";

/** Codes the portal has its own error line for. */
export type DirectoryPortalErrorCode =
  "required" | "tooLong" | "format" | "tooMany" | "tooFew";

export type DirectoryFieldIssueCode =
  | DirectoryPortalErrorCode
  | "unknownOption"
  | "unknownField"
  /** A confirmed declaration whose wording changed since it was confirmed. */
  | "wordingChanged"
  /** A write to a field only an imported package may set. */
  | "managedByPackage"
  /** A secret field names a project secret that holds no value. */
  | "secretUnset";

export interface DirectoryFlowField {
  /** `<step>.<name>`. Stable forever once shipped: stored answers use it. */
  key: string;
  label: string;
  /** The review page's label, when it differs from the form's. */
  reviewLabel?: string;
  control: DirectoryFieldControl;
  /** The portal refuses to submit without it. */
  required?: boolean;
  /** `review`: only the review page asks for it (Claude's author). */
  requiredOn?: "form" | "review";
  /** Required once any of these fields has an answer (sign-in steps for a named tenant). */
  requiredWith?: string[];
  /**
   * `package`: the portal shows the value read only and takes it from the
   * uploaded package, so only an import sets it.
   */
  managedBy?: "package";
  /**
   * Where the package holds the value: a file, then a JSON pointer, in the
   * layout the portal recommends (`*` stands for the connected server).
   */
  packagePath?: string;
  /**
   * Answers that stand in for a missing value, each valid in its own right
   * and all of them present: Claude's author falls back to the company name
   * and an https website.
   */
  satisfiedBy?: Array<{ key: string; format?: DirectoryFieldFormat }>;
  placeholder?: string;
  helper?: string;
  options?: DirectoryFlowOption[];
  /** A choice field whose options were never captured takes any value. */
  freeEntry?: boolean;
  pairs?: {
    columns: [string, string];
    keys: [string, string];
    placeholders?: [string, string][];
    maxRows: number;
  };
  /** Characters, counted as the portal's counter counts them. */
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  format?: DirectoryFieldFormat;
  /** What an empty portal draft already holds. Derived, never stored. */
  default?: DirectoryAnswerValue;
  /** The portal fills it from the account; the API stores it at create. */
  prefill?: "account-name" | "account-email" | "organization-name";
  /** A statement someone must stand behind, so confirming it is recorded. */
  declaration?: boolean;
  /** Bumped when the label or options change meaning. Defaults to the flow's version. */
  wordingRevision?: string;
  /** The portal's exact error lines. Codes without one get MCPJam's wording. */
  errors: Partial<Record<DirectoryPortalErrorCode, string>>;
}

/**
 * How the portal draws a step, for a page that copies it. No rule reads
 * these: a block names fields (two side by side), a heading, or something the
 * page draws itself (`widget`) with the portal's wording in `text`.
 */
export interface DirectoryLayoutBlock {
  fields?: string[];
  heading?: string;
  note?: string;
  widget?: string;
  text?: Partial<Record<string, string>>;
}

/** One section of the portal's review page, in the portal's order. */
export interface DirectoryReviewSection {
  id: string;
  title: string;
  /** The step its Edit link opens. */
  edit: string;
  /**
   * Field keys, or a row the portal derives with its own error line, shown
   * while `blank` (a field key) has no answer.
   */
  rows: Array<string | { label: string; error: string; blank: string }>;
  /** One summary line that never opens. */
  flat?: boolean;
}

export interface DirectoryStepLayout {
  blocks?: DirectoryLayoutBlock[];
  review?: DirectoryReviewSection[];
}

export interface DirectoryFlowStep {
  id: string;
  title: string;
  intro: string;
  fields: DirectoryFlowField[];
  layout?: DirectoryStepLayout;
}

/** What a check cannot reach a verdict without. */
export type DirectoryCheckNeed = "server" | "reviewer" | "model" | "package";

export interface DirectoryCheckPlacement {
  /**
   * The engine finding id. One ending in `.*` places every id under that
   * prefix, for findings an engine names at run time, such as one per file
   * it could not read.
   */
  checkId: string;
  step: string;
  /** The field the result is shown under. */
  field?: string;
  /** Answer keys the check reads; a change to one makes its result stale. */
  reads?: string[];
  needs?: DirectoryCheckNeed[];
}

export interface DirectoryFlow {
  id: DirectoryFlowId;
  directory: "claude" | "openai";
  title: string;
  /** Date of the portal capture the wording and rules were copied from. */
  version: string;
  source: { label: string; url: string; capturedAt: string };
  /** The directory's real submission page. */
  submissionUrl: string;
  steps: DirectoryFlowStep[];
  placements: DirectoryCheckPlacement[];
  /** Step that receives a finding with no placement, by engine lane. */
  laneSteps: Record<string, string>;
}

/** A declaration nobody has stood behind yet (see `unconfirmedDeclarations`). */
export interface DirectoryUnconfirmedDeclaration {
  key: string;
  step: string;
  /** The label the review page shows. */
  label: string;
  /** Where its value came from; absent when the field has no answer. */
  origin?: DirectoryAnswerOrigin;
  value?: DirectoryAnswerValue;
}

export interface DirectoryFieldIssue {
  key: string;
  step: string;
  code: DirectoryFieldIssueCode;
  /** The portal's wording when the flow has it. */
  message: string;
}

/**
 * How far a result can be trusted now:
 *
 *   - `established` — the run reached a settled result.
 *   - `inconclusive` — a model flagged something and said it was unsure.
 *   - `stale` — established, but an answer it read has changed since.
 *   - `not-tested` — the run did not evaluate it, with a stated reason.
 *   - `blocked` — the run lacked something the check depends on.
 */
export type DirectoryEvidenceStatus =
  "established" | "inconclusive" | "stale" | "not-tested" | "blocked";

export interface PlacedFinding {
  finding: DirectoryReadinessFinding;
  step: string;
  field?: string;
  evidenceStatus: DirectoryEvidenceStatus;
  /** The answer keys whose change made it stale. */
  staleBecause?: string[];
}

export interface PlacedStep {
  step: string;
  fieldIssues: DirectoryFieldIssue[];
  findings: PlacedFinding[];
  counts: {
    /** Fields with an issue, as the portal's step marker counts them. */
    toFix: number;
    /** Established violations of a requirement. */
    blockers: number;
    /** Violations that are not requirements, and model observations. */
    likelyFlags: number;
    /** Not tested, blocked or stale: no current evidence either way. */
    notChecked: number;
    passed: number;
  };
}
