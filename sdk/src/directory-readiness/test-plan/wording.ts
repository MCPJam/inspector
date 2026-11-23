/**
 * The words a plan's issues and a case's results are shown in. They are data
 * in `wording.json` so the copy is reviewed in one place; the keys are typed
 * from it, so a missing entry fails to compile. An issue's key starts with its
 * code: `writeScope.missing` is a `writeScope` issue.
 */

import data from "./wording.json" with { type: "json" };
import type { DirectoryTestPlanIssueCode } from "./types.js";

export type IssueWording = keyof typeof data.issues;
export type CaseWording = keyof typeof data.cases;

type Vars = Readonly<Record<string, string | number | undefined>>;

function fill(template: string, vars: Vars): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) =>
    String(vars[key] ?? "")
  );
}

export function issueWords(key: IssueWording, vars: Vars) {
  const code = key.split(".")[0] as DirectoryTestPlanIssueCode;
  return { code, message: fill(data.issues[key], vars) };
}

export const caseWords = (key: CaseWording, vars: Vars = {}) =>
  fill(data.cases[key], vars);

/** How a call answered, as a phrase: "a server error". */
export const answerWords = (key: keyof typeof data.answers) =>
  data.answers[key];
