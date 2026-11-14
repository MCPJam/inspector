/**
 * The ChatGPT portal's "Metadata & Skills" tab: the plugin's package details,
 * read only as the portal shows them, each with where the package keeps it
 * and MCPJam's results for the checks that read it.
 *
 * Nobody edits a package field here: its value is what an import from the
 * package stored, and the portal's answer to a wrong one is a new version.
 */
import type {
  DirectoryAnswerValue,
  DirectoryFlowField,
  DirectoryFlowStep,
  PlacedFinding,
} from "@mcpjam/sdk/browser";
import { cn } from "@mcpjam/design-system/cn";
import type { AnswerValues } from "@/hooks/use-directory-submission";
import { McpjamChecks } from "./McpjamChecks";
import { McpjamNote } from "./PortalWidgets";

const BLANK = "—";

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
