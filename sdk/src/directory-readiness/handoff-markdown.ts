/**
 * The export pack as Markdown, for a person to read or paste into a ticket.
 *
 * Rendered from the JSON pack alone, so both formats hold the same data, and
 * from nothing that changes between reads (no clock), so exporting the same
 * record twice gives the same bytes on every surface.
 *
 * Pure. Safe from the browser entry.
 */

import type { DirectoryExport } from "./handoff.js";

type Recorded = { reportedOrObserved: string; actor: string; actorLabel?: string; createdAt: number };

const time = (ms: number) => new Date(ms).toISOString();
const code = (text: string) => `\`${text}\``;
const by = (entry: Recorded) =>
  `${entry.reportedOrObserved} by ${entry.actorLabel ?? entry.actor} at ${time(entry.createdAt)}`;
/** Keeps a multi-line value inside its list item. */
const inline = (value: unknown) =>
  typeof value === "string" ? value.replace(/\n/g, "\n  ") : JSON.stringify(value);

function section(title: string, items: string[]): string[] {
  return ["", `## ${title}`, "", ...(items.length > 0 ? items.map((item) => `- ${item}`) : ["None."])];
}

export function renderDirectoryExportMarkdown(pack: DirectoryExport): string {
  const { submission: s, status, counts, verdict, links } = pack;
  const steps = counts.steps.map(({ step, title }) => ({ step, title }));
  const title = new Map(steps.map((entry) => [entry.step, entry.title]));
  const where = (step: string, field?: string) => `${title.get(step) ?? step}${field ? `, ${code(field)}` : ""}`;
  const byStep = <T extends { step: string }>(heading: string, items: T[], line: (item: T) => string) => [
    "",
    `## ${heading}`,
    ...steps.flatMap(({ step, title: stepTitle }) => {
      const here = items.filter((item) => item.step === step);
      return here.length > 0 ? ["", `### ${stepTitle}`, "", ...here.map((item) => `- ${line(item)}`)] : [];
    }),
  ];
  const lines = [
    `# ${s.flowTitle}: ${s.title || s.id}`,
    "",
    `Submission ${code(s.id)} at revision ${s.revision}, last changed ${time(s.updatedAt)}. Rules as of ${s.rulesVersion}.`,
    `Submit in the directory at ${links.submissionUrl}`,
    ...(links.managementUrl ? [`Manage the submission at ${links.managementUrl}`] : []),
    ...Object.entries(s.refs)
      .filter(([key]) => key !== "managementUrl")
      .map(([key, value]) => `${key}: ${value}`),
    ...section(
      "Status",
      status
        ? [
            [
              `${status.state}${status.directoryLabel ? ` ("${status.directoryLabel}")` : ""}, ${by(status)}`,
              status.uncertain ? ", uncertain" : "",
              status.reference ? `. Reference: ${status.reference}` : "",
              status.link ? `. ${status.link}` : "",
              status.detail ? `. ${inline(status.detail)}` : "",
            ].join(""),
          ]
        : []
    ),
    ...section(
      "Remaining portal actions",
      pack.remainingPortalActions.map(
        (entry) =>
          `${entry.label}${entry.label === title.get(entry.step) ? "" : ` (${where(entry.step)})`}` +
          (entry.secretName ? `: type the value of the project secret ${code(entry.secretName)}` : "") +
          (entry.why ? `. ${entry.why}` : "")
      )
    ),
    ...section(
      "Still unknown",
      pack.unknowns.map((entry) => `${entry.id ? `${code(entry.id)}: ` : ""}${entry.detail}`)
    ),
    ...section(
      "Next actions in MCPJam",
      pack.nextActions.map(
        (entry) =>
          `${code(entry.operation)}: ${entry.why}` +
          (entry.fields ? ` Fields: ${entry.fields.map(code).join(", ")}.` : "")
      )
    ),
    ...section("Counts", [
      `Verdict under the gate: ${verdict.verdict}. Fails on: ${verdict.gate.failOn.join(", ") || "the default"}. Warn only: ${verdict.gate.warnOnly.join(", ") || "none"}.`,
      ...counts.steps.map(
        (entry) =>
          `${entry.title}: ${plural(entry.findings, "finding")}, ${entry.blockers} blocking, ${entry.toFix} to fix, ${entry.notChecked} not checked, ${entry.passed} passed`
      ),
    ]),
    ...section(
      "Blockers",
      pack.blockers.map(
        (entry) =>
          `${entry.title} (${code(entry.checkId)}), ${where(entry.step, entry.field)}` +
          (entry.remediation ? `: ${entry.remediation}` : "")
      )
    ),
    ...byStep("Answers", pack.answers, (entry) => {
      const name = `${entry.label} (${code(entry.key)})`;
      if (entry.value === null) return `${name}: not answered`;
      const value = entry.secret ? `the project secret ${code(String(entry.value))}` : inline(entry.value);
      const setBy = entry.setByLabel ?? entry.setBy;
      return `${name}: ${value} (${entry.origin}${setBy ? `, set by ${setBy}` : ""}${entry.setVia ? ` via ${entry.setVia}` : ""})`;
    }),
    ...byStep(
      "Findings",
      pack.findings,
      (entry) =>
        `${entry.evidenceStatus}, ${entry.status}: ${entry.title} (${code(entry.checkId)})` +
        (entry.field ? ` on ${code(entry.field)}` : "") +
        (entry.staleBecause ? `; ${entry.staleBecause.map(code).join(", ")} changed since the run` : "") +
        (entry.remediation ? `. ${entry.remediation}` : "")
    ),
    ...section(
      "What the directory said",
      pack.directoryFindings.map(
        (entry) =>
          `By ${entry.via}${entry.receivedAt ? ` on ${time(entry.receivedAt)}` : ""}, ${by(entry)}` +
          [entry.severity, entry.code, entry.version && `version ${entry.version}`]
            .filter(Boolean)
            .map((part) => `; ${part}`)
            .join("") +
          `:\n${entry.text.replace(/^/gm, "  > ")}`
      )
    ),
    ...section(
      "Snapshots",
      Object.entries(pack.snapshots.latest).map(([label, entry]) =>
        entry
          ? `${label}: ${entry.contractHash ? `revision ${entry.revisionNumber}, ${entry.counts?.tools ?? 0} tools` : "no revision named"}, ${by(entry)}`
          : `${label}: not recorded`
      )
    ),
    ...section("Credentials", [
      ...pack.credentials.secrets.map(
        (entry) =>
          `${entry.label} (${code(entry.key)}): ${entry.secretName ? `the project secret ${code(entry.secretName)}` : "no secret named"}`
      ),
      ...(["saved", "tested", "delivered"] as const).map((state) => {
        const entry = pack.credentials[state];
        return `${state}: ${entry ? by(entry) : "not recorded"}`;
      }),
    ]),
  ];
  return `${lines.join("\n")}\n`;
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;
