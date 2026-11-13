/**
 * The ChatGPT portal's "Metadata & Skills" tab: the plugin's package details,
 * read only as the portal shows them, each with where the package keeps it
 * and MCPJam's results for the checks that read it; then the version's
 * skills with the status the last run gives each.
 *
 * Nobody edits a package field here: its value is what an import from the
 * package stored, and the portal's answer to a wrong one is a new version.
 */
import { formatDistanceToNow } from "date-fns";
import type {
  DirectoryAnswerValue,
  DirectoryFlowField,
  DirectoryFlowStep,
  PlacedFinding,
} from "@mcpjam/sdk/browser";
import { cn } from "@mcpjam/design-system/cn";
import type { AnswerValues } from "@/hooks/use-directory-submission";
import type { PluginVersionSkillComponent } from "@/lib/plugins/plugin-api-types";
import { McpjamChecks, openResult } from "./McpjamChecks";
import { Chip, mentions } from "./OpenAiFindings";
import { McpjamNote } from "./PortalWidgets";

const BLANK = "—";
export const TABLE_HEAD = "pb-2 text-xs font-normal text-muted-foreground";
export const TABLE_CELL = "py-2.5 pr-4";
const TONE = { passed: "good", attention: "warn", unchecked: undefined } as const;

/** The file and key a package keeps a field under: `plugin.json: websiteURL`. */
export function packageSource(path: string): string {
  const [file, pointer = ""] = path.split("#/");
  return `${file}: ${pointer.split("/").pop()}`;
}

function shown(field: DirectoryFlowField, value: DirectoryAnswerValue | undefined) {
  const list = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
  const labels = list.flatMap((entry) =>
    typeof entry === "string" && entry.trim()
      ? [field.options?.find((option) => option.value === entry)?.label ?? entry]
      : [],
  );
  return labels.join(", ") || BLANK;
}

function PackageField({
  field,
  value,
  findings,
}: {
  field: DirectoryFlowField;
  value: DirectoryAnswerValue | undefined;
  findings: readonly PlacedFinding[];
}) {
  const text = shown(field, value);
  // The portal puts "About" above its text and the rest beside their labels.
  const wide = field.control === "textarea";
  return (
    <div className={wide ? "space-y-1" : "grid grid-cols-[8rem_minmax(0,1fr)] gap-x-4"}>
      <dt className="text-sm text-muted-foreground">{field.label}</dt>
      <dd className="min-w-0 space-y-1 text-sm">
        <p
          className={cn(
            "whitespace-pre-wrap break-words",
            text !== BLANK && field.format && "underline underline-offset-2",
          )}
        >
          {text}
        </p>
        {field.packagePath ? (
          <p
            title={field.packagePath}
            className="truncate font-mono text-xs text-muted-foreground"
          >
            {packageSource(field.packagePath)}
          </p>
        ) : null}
        <McpjamChecks findings={findings.filter((entry) => entry.field === field.key)} />
      </dd>
    </div>
  );
}

export function OpenAiMetadata({
  step,
  values,
  findings,
}: {
  step: DirectoryFlowStep;
  values: AnswerValues;
  /** MCPJam's results on the tab. */
  findings: readonly PlacedFinding[];
}) {
  const metadata = step.layout?.blocks?.find((block) => block.heading && block.fields);
  const fields = (metadata?.fields ?? []).flatMap((key) =>
    step.fields.filter((field) => field.key === key),
  );
  // Links in the right column, as the portal lays them out.
  const column = (test: (field: DirectoryFlowField) => boolean) => (
    <dl className="space-y-3">
      {fields.filter(test).map((field) => (
        <PackageField
          key={field.key}
          field={field}
          value={values[field.key]}
          findings={findings}
        />
      ))}
    </dl>
  );
  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <h2 className="text-xl font-semibold">{metadata?.heading}</h2>
        <p className="text-sm text-muted-foreground">{step.intro}</p>
      </div>
      {fields.every((field) => shown(field, values[field.key]) === BLANK) ? (
        <McpjamNote>
          The package's values are not imported into this rehearsal. Run checks
          to grade the package itself.
        </McpjamNote>
      ) : null}
      {column((field) => field.control === "textarea")}
      <div className="grid gap-x-8 gap-y-3 md:grid-cols-2">
        {column((field) => field.control !== "textarea" && !field.format)}
        {column((field) => field.control !== "textarea" && Boolean(field.format))}
      </div>
    </section>
  );
}

/** A skill needs attention when an open skill result names it, or names none. */
function skillStatus(name: string, all: readonly string[], results: readonly PlacedFinding[]) {
  const about = results.filter((entry) => /^openai\.(skills\.|package\.skills)/.test(entry.finding.id));
  const current = (entry: PlacedFinding) =>
    entry.evidenceStatus === "established" || entry.evidenceStatus === "inconclusive";
  if (about.length === 0 || !about.every(current)) return "unchecked";
  const names = (entry: PlacedFinding) =>
    mentions(entry, name) || !all.some((other) => mentions(entry, other));
  return about.some((entry) => openResult(entry) && names(entry)) ? "attention" : "passed";
}

/** The version's skills, each with the status the last run of it gives. */
export function OpenAiSkills({
  step,
  findings,
  skills,
  checkedAt,
}: {
  step: DirectoryFlowStep;
  findings: readonly PlacedFinding[];
  skills: readonly PluginVersionSkillComponent[] | undefined;
  /** When the run of this version finished; absent before one. */
  checkedAt?: number;
}) {
  const block = step.layout?.blocks?.find((entry) => entry.widget === "skills");
  if (!block) return null;
  const names = (skills ?? []).map((skill) => skill.declaredName);
  const words: Record<string, string | undefined> = { unchecked: "Not checked", ...block.text };
  return (
    <section className="space-y-3">
      <h2 className="text-xl font-semibold">{block.heading}</h2>
      <table className="w-full text-left text-sm">
        <thead>
          <tr>
            <th className={TABLE_HEAD}>Skill</th>
            <th className={TABLE_HEAD}>Status</th>
            <th className={TABLE_HEAD}>Last checked</th>
          </tr>
        </thead>
        <tbody>
          {names.map((name) => {
            const state = checkedAt ? skillStatus(name, names, findings) : "unchecked";
            return (
              <tr key={name} className="border-t border-border">
                <td className={TABLE_CELL}>{name}</td>
                <td className={TABLE_CELL}>
                  <Chip tone={TONE[state]}>{words[state]}</Chip>
                </td>
                <td className={cn(TABLE_CELL, "text-muted-foreground")}>
                  {checkedAt && state !== "unchecked"
                    ? formatDistanceToNow(checkedAt, { addSuffix: true })
                    : BLANK}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {skills && names.length === 0 ? (
        <p className="text-sm text-muted-foreground">This version has no skills.</p>
      ) : null}
    </section>
  );
}
