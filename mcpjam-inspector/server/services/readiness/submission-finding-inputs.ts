import {
  canonicalDigest,
  directoryPlacementOf,
  withDirectoryFlowDefaults,
  type DirectoryAnswer,
  type DirectoryFlow,
  type PlacedFinding,
} from "@mcpjam/sdk";

type DirectoryReadinessFinding = PlacedFinding["finding"];

type Input = { kind: string; key: string; fingerprint: string };
export type FindingWithInputs = DirectoryReadinessFinding & {
  inputs?: Input[];
};

export interface SubmissionFindingContext {
  flow: DirectoryFlow;
  answers: readonly DirectoryAnswer[];
  pluginVersionId?: string;
  flowVersion?: string;
}

/** Fingerprints preserve dependency comparisons after the run report expires. */
export function submissionFindingInputs(
  finding: DirectoryReadinessFinding,
  context: SubmissionFindingContext,
): Input[] {
  const placement = directoryPlacementOf(context.flow, finding.id);
  const answers = new Map(
    withDirectoryFlowDefaults(context.flow, context.answers).map((answer) => [
      answer.key,
      answer,
    ]),
  );
  const inputs: Input[] = (placement?.reads ?? []).map((key) => {
    const answer = answers.get(key);
    return {
      kind: "answer",
      key,
      fingerprint: canonicalDigest([
        answer?.value ?? null,
        answer?.wordingRevision ?? null,
      ]),
    };
  });
  inputs.push({
    kind: "rule",
    key: context.flow.id,
    fingerprint: canonicalDigest(context.flowVersion ?? context.flow.version),
  });
  if (placement?.needs?.includes("package")) {
    inputs.push({
      kind: "package",
      key: "pluginVersionId",
      fingerprint: canonicalDigest(context.pluginVersionId ?? null),
    });
  }
  return inputs;
}

export function changedFindingInputs(
  finding: FindingWithInputs,
  context: SubmissionFindingContext,
): string[] {
  if (!finding.inputs) return [];
  const current = new Map(
    submissionFindingInputs(finding, context).map((input) => [
      `${input.kind}:${input.key}`,
      input.fingerprint,
    ]),
  );
  return finding.inputs
    .filter(
      (input) =>
        current.get(`${input.kind}:${input.key}`) !== input.fingerprint,
    )
    .map((input) => input.key);
}
