/** Read only portal-owned fields from the package; never import credentials or attestations. */
import type { DirectoryAnswer } from "../../directory-readiness/flows/types.js";
import type { OpenAIPluginPackageEvidence } from "./reader.js";

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}

export function openAIPackageSubmissionAnswers(
  evidence: OpenAIPluginPackageEvidence | undefined,
  savedAnswers: readonly DirectoryAnswer[] = []
): DirectoryAnswer[] {
  const manifest = evidence?.manifest?.raw;
  if (!manifest) return [];
  const extension = record(record(manifest.extensions)?.["com.openai"]);
  const presentation =
    record(extension?.interface) ?? record(manifest.interface);
  const review = record(extension?.review);
  const publication = record(extension?.publication);
  const tests = record(review?.test_cases);
  const pairs: Array<[string, unknown]> = [
    ["listing.displayName", presentation?.displayName],
    ["listing.shortDescription", presentation?.shortDescription],
    ["listing.description", presentation?.longDescription],
    ["listing.category", presentation?.category],
    ["listing.privacyPolicy", presentation?.privacyPolicyURL],
    ["listing.support", presentation?.supportURL],
    ["reviewer.demoRecordingUrl", review?.demo_recording_url],
    ["reviewer.releaseNotes", publication?.release_notes],
  ];
  // An observed empty field is different from a package the run never read.
  const answers: DirectoryAnswer[] = pairs.map(([key, value]) => ({
    key,
    value:
      value == null && key.startsWith("reviewer.")
        ? (savedAnswers.find((answer) => answer.key === key)?.value ?? "")
        : typeof value === "string"
          ? value
          : "",
    origin: "imported",
  }));
  if (evidence.manifest?.mcpServerNames.length === 1) {
    for (const [key, value] of [
      ["reviewer.testCases", tests?.positive],
      ["reviewer.negativeTestCases", tests?.negative],
    ] as const) {
      answers.push({
        key,
        value: Array.isArray(value)
          ? value.map((row) =>
              Object.fromEntries(
                Object.entries(record(row) ?? {}).filter(
                  (entry): entry is [string, string] =>
                    typeof entry[1] === "string"
                )
              )
            )
          : review?.test_cases == null
            ? (savedAnswers.find((answer) => answer.key === key)?.value ?? [])
            : [],
        origin: "imported",
      });
    }
  }
  return answers;
}

/** Omission preserves existing targeting; an explicit empty list means unrestricted. */
export function openAIPackageCountries(
  evidence: OpenAIPluginPackageEvidence | undefined
): unknown {
  const extension = record(
    record(evidence?.manifest?.raw?.extensions)?.["com.openai"]
  );
  return record(extension?.publication)?.countries;
}
