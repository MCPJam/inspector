/**
 * OpenAI plugin-submission report (INS-5).
 *
 * OpenAI's directory review asks for a fixed evidence shape: FIVE prompts where
 * the plugin should be invoked and THREE where it must stay out of the way.
 * MCPJam suites already carry that distinction — `isNegativeTest` marks the
 * "should not trigger" cases, and `scenario` is the field authors use to say
 * why — so a submission is a projection of a run, not a new authoring flow.
 *
 * The report is built from ONE run, and it names the exact plugin bundle that
 * run executed. That is the whole reason it lives here rather than over "the
 * suite": a suite is live and editable, so "these 8 prompts pass" is only a
 * claim about a specific bundle if it comes from the immutable record of a
 * single execution.
 *
 * IT DOES NOT LAUNDER A FAILING RUN. `readiness` reports every shortfall —
 * too few cases of either kind, any failing selection, no plugin pinned, the
 * skills-excluded arm — and the rendered document states them at the top rather
 * than omitting the offending case to make the counts work. A report that
 * silently dropped a failure would be the most expensive kind of green.
 */

export interface SubmissionRunCase {
  title: string;
  /** The prompt as executed, from the iteration's frozen snapshot. */
  query: string;
  isNegativeTest: boolean;
  /** Author's note on why the plugin should not trigger (negative cases). */
  scenario?: string;
  expectedToolCalls: string[];
  actualToolCalls: string[];
  passed: boolean;
  model?: string;
  provider?: string;
}

export interface SubmissionPluginVersion {
  name: string;
  pluginVersionId: string;
  bundleHash: string;
}

/** How many of each kind OpenAI asks for. */
export const OPENAI_POSITIVE_TARGET = 5;
export const OPENAI_NEGATIVE_TARGET = 3;

export type SubmissionReadinessIssue =
  | { code: "insufficient_positive"; have: number; need: number }
  | { code: "insufficient_negative"; have: number; need: number }
  | { code: "failing_cases"; titles: string[] }
  | { code: "no_plugin_pinned" }
  | { code: "skills_excluded" };

export interface OpenAiSubmissionReport {
  suiteName: string;
  runLabel: string;
  generatedAt: number;
  pluginVersions: SubmissionPluginVersion[];
  positive: SubmissionRunCase[];
  negative: SubmissionRunCase[];
  /** Empty ⇒ this run satisfies OpenAI's evidence shape as-is. */
  readiness: SubmissionReadinessIssue[];
}

/**
 * Pick the cases to submit.
 *
 * PASSING CASES FIRST, then failing ones, and the selection is truncated to the
 * target count only AFTER that ordering — so a suite with six passing positives
 * submits five passing ones, while a suite with four passing and two failing
 * submits four passing plus one failing AND reports the failure. Dropping the
 * failing case instead would produce a clean-looking report from a run that is
 * not clean, which is precisely the document nobody should be able to generate
 * by accident.
 *
 * Stable within each group: input order (the run's own case order) is
 * preserved, so regenerating a report for the same run yields the same
 * document.
 */
function selectCases(
  cases: SubmissionRunCase[],
  target: number
): SubmissionRunCase[] {
  const passing = cases.filter((entry) => entry.passed);
  const failing = cases.filter((entry) => !entry.passed);
  return [...passing, ...failing].slice(0, target);
}

export function buildOpenAiSubmissionReport(args: {
  suiteName: string;
  runLabel: string;
  cases: SubmissionRunCase[];
  pluginVersions: SubmissionPluginVersion[];
  skillsExcluded?: boolean;
  now?: number;
}): OpenAiSubmissionReport {
  const positive = selectCases(
    args.cases.filter((entry) => !entry.isNegativeTest),
    OPENAI_POSITIVE_TARGET
  );
  const negative = selectCases(
    args.cases.filter((entry) => entry.isNegativeTest),
    OPENAI_NEGATIVE_TARGET
  );

  const readiness: SubmissionReadinessIssue[] = [];
  if (positive.length < OPENAI_POSITIVE_TARGET) {
    readiness.push({
      code: "insufficient_positive",
      have: positive.length,
      need: OPENAI_POSITIVE_TARGET,
    });
  }
  if (negative.length < OPENAI_NEGATIVE_TARGET) {
    readiness.push({
      code: "insufficient_negative",
      have: negative.length,
      need: OPENAI_NEGATIVE_TARGET,
    });
  }
  const failingTitles = [...positive, ...negative]
    .filter((entry) => !entry.passed)
    .map((entry) => entry.title);
  if (failingTitles.length > 0) {
    readiness.push({ code: "failing_cases", titles: failingTitles });
  }
  if (args.pluginVersions.length === 0) {
    // Without a pinned bundle the document is evidence about nothing in
    // particular: the plugin it describes is whatever was installed that day.
    readiness.push({ code: "no_plugin_pinned" });
  }
  if (args.skillsExcluded) {
    // The "without skills" A/B arm. Its results are real, but they are not
    // evidence about a plugin whose value is partly its skills.
    readiness.push({ code: "skills_excluded" });
  }

  return {
    suiteName: args.suiteName,
    runLabel: args.runLabel,
    generatedAt: args.now ?? Date.now(),
    pluginVersions: args.pluginVersions,
    positive,
    negative,
    readiness,
  };
}

export function describeSubmissionIssue(issue: SubmissionReadinessIssue): string {
  switch (issue.code) {
    case "insufficient_positive":
      return `Only ${issue.have} of the ${issue.need} required "should invoke" prompts ran in this run. Add cases to the suite and re-run.`;
    case "insufficient_negative":
      return `Only ${issue.have} of the ${issue.need} required "should NOT invoke" prompts ran in this run. Mark cases as negative tests and re-run.`;
    case "failing_cases":
      return `These selected cases FAILED in this run and are included as-is: ${issue.titles.join(
        ", "
      )}.`;
    case "no_plugin_pinned":
      return "This run pinned no plugin version, so the report cannot state which bundle was evaluated. Run the suite against an environment that pins the plugin.";
    case "skills_excluded":
      return "This run is the 'without skills' arm of a compare — no skills were delivered from any channel. Submit the arm that includes them.";
  }
}

function renderCase(entry: SubmissionRunCase, index: number): string {
  const lines = [
    `${index + 1}. **${entry.title}** — ${entry.passed ? "PASS" : "FAIL"}`,
    "",
    `   Prompt: ${entry.query}`,
  ];
  if (entry.model) {
    lines.push(
      `   Model: ${entry.provider ? `${entry.provider}/` : ""}${entry.model}`
    );
  }
  if (entry.scenario) lines.push(`   Why it should not trigger: ${entry.scenario}`);
  lines.push(
    `   Expected tool calls: ${
      entry.expectedToolCalls.length > 0
        ? entry.expectedToolCalls.join(", ")
        : "none"
    }`
  );
  lines.push(
    `   Actual tool calls: ${
      entry.actualToolCalls.length > 0
        ? entry.actualToolCalls.join(", ")
        : "none"
    }`
  );
  return lines.join("\n");
}

/** Markdown rendering of a report — the artifact a submitter attaches. */
export function renderOpenAiSubmissionReport(
  report: OpenAiSubmissionReport
): string {
  const sections: string[] = [
    `# OpenAI submission evidence — ${report.suiteName}`,
    "",
    `Run: ${report.runLabel}`,
    `Generated: ${new Date(report.generatedAt).toISOString()}`,
    "",
    "## Plugin bundle evaluated",
    "",
  ];

  if (report.pluginVersions.length === 0) {
    sections.push("_No plugin version was pinned by this run._", "");
  } else {
    for (const version of report.pluginVersions) {
      sections.push(
        `- **${version.name}** — bundle \`${version.bundleHash}\` (version ${version.pluginVersionId})`
      );
    }
    sections.push("");
  }

  if (report.readiness.length > 0) {
    // At the TOP, never a footnote: this is what a reviewer needs before they
    // read a single result.
    sections.push("## Not ready to submit", "");
    for (const issue of report.readiness) {
      sections.push(`- ${describeSubmissionIssue(issue)}`);
    }
    sections.push("");
  }

  sections.push(
    `## Should invoke (${report.positive.length}/${OPENAI_POSITIVE_TARGET})`,
    ""
  );
  sections.push(
    report.positive.length > 0
      ? report.positive.map(renderCase).join("\n\n")
      : "_None._"
  );
  sections.push(
    "",
    `## Should NOT invoke (${report.negative.length}/${OPENAI_NEGATIVE_TARGET})`,
    ""
  );
  sections.push(
    report.negative.length > 0
      ? report.negative.map(renderCase).join("\n\n")
      : "_None._"
  );
  sections.push("");

  return sections.join("\n");
}
