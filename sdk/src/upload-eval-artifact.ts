import type {
  EvalResultInput,
  ReportEvalResultsInput,
  ReportEvalResultsOutput,
} from "./eval-reporting-types.js";
import {
  parseJestJsonArtifact,
  parseJUnitXmlArtifact,
  parseVitestJsonArtifact,
} from "./artifact-parsers/index.js";
import { reportEvalResults } from "./report-eval-results.js";

export type EvalArtifactFormat =
  | "junit-xml"
  | "jest-json"
  | "vitest-json"
  | "custom";

export type UploadEvalArtifactInput = Omit<
  ReportEvalResultsInput,
  "results"
> & {
  artifact: string | Uint8Array | Record<string, unknown>;
  format: EvalArtifactFormat;
  customParser?: (
    artifact: string | Uint8Array | Record<string, unknown>
  ) => EvalResultInput[];
};

function artifactToString(artifact: string | Uint8Array): string {
  if (typeof artifact === "string") {
    return artifact;
  }
  return new TextDecoder().decode(artifact);
}

function artifactToObject(
  artifact: string | Uint8Array | Record<string, unknown>
): Record<string, unknown> {
  if (
    artifact &&
    typeof artifact === "object" &&
    !ArrayBuffer.isView(artifact)
  ) {
    return artifact;
  }
  const asString = artifactToString(artifact as string | Uint8Array);
  const parsed = JSON.parse(asString);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Artifact JSON must be an object");
  }
  return parsed as Record<string, unknown>;
}

function parseArtifactResults(
  input: UploadEvalArtifactInput
): EvalResultInput[] {
  switch (input.format) {
    case "junit-xml":
      return parseJUnitXmlArtifact(
        artifactToString(input.artifact as string | Uint8Array)
      );
    case "jest-json":
      return parseJestJsonArtifact(
        artifactToObject(input.artifact) as Parameters<
          typeof parseJestJsonArtifact
        >[0]
      );
    case "vitest-json":
      return parseVitestJsonArtifact(
        artifactToObject(input.artifact) as Parameters<
          typeof parseVitestJsonArtifact
        >[0]
      );
    case "custom":
      if (!input.customParser) {
        throw new Error("customParser is required when format is 'custom'");
      }
      return input.customParser(input.artifact);
    default:
      throw new Error(`Unsupported artifact format: ${String(input.format)}`);
  }
}

export async function uploadEvalArtifact(
  input: UploadEvalArtifactInput
): Promise<ReportEvalResultsOutput> {
  const results = parseArtifactResults(input);
  return await reportEvalResults({
    suiteName: input.suiteName,
    suiteDescription: input.suiteDescription,
    serverNames: input.serverNames,
    notes: input.notes,
    passCriteria: input.passCriteria,
    externalRunId: input.externalRunId,
    framework: input.framework,
    ci: input.ci,
    apiKey: input.apiKey,
    baseUrl: input.baseUrl,
    strict: input.strict,
    results,
  });
}
