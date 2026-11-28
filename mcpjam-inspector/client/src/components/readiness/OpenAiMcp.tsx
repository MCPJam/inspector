/**
 * The ChatGPT portal's "MCPs" tab: the connect panel for the plugin's MCP
 * server (the URL MCPJam grades, the authentication its mcp.json declares,
 * its key, and the domain verification state with the token the portal
 * issues), then the tools the last run read, each with the open results
 * that name it.
 *
 * MCPJam grades the submission's saved server, so that is the URL shown. A
 * package whose mcp.json names another is told so, since the portal connects
 * the one in the package.
 */
import { useState, type ReactNode } from "react";
import { formatDistanceToNow } from "date-fns";
import { Check, RefreshCw } from "lucide-react";
import type {
  DirectoryAnswerValue,
  DirectoryFlowStep,
  PlacedFinding,
} from "@mcpjam/sdk/browser";
import { Button } from "@mcpjam/design-system/button";
import type { AnswerValues } from "@/hooks/use-directory-submission";
import type { PluginVersionServerComponent } from "@/lib/plugins/plugin-api-types";
import { McpjamChecks, McpjamMark, openResult } from "./McpjamChecks";
import { Chip, holds, mentions } from "./OpenAiFindings";
import { TABLE_CELL, TABLE_HEAD } from "./OpenAiMetadata";
import { PortalField } from "./PortalField";
import { McpjamNote } from "./PortalWidgets";

/** The checks of the server's connection: its URL, sign-in and domain. */
export const CONNECTION = /^openai\.(endpoint|auth|domain)\./;

/** Every check holds on this version's run, and there is one to hold. */
export const allHold = (entries: readonly PlacedFinding[], checkedAt?: number) =>
  checkedAt !== undefined && entries.length > 0 && entries.every(holds);

/** The tools the run read, from the tool results that list them by name. */
export function toolsOf(findings: readonly PlacedFinding[]): string[] {
  const names = new Set<string>();
  for (const { finding } of findings) {
    if (!finding.id.startsWith("openai.tools.")) continue;
    for (const list of Object.values(finding.details ?? {})) {
      for (const item of Array.isArray(list) ? list : []) {
        const name = typeof item === "object" && item && "name" in item ? item.name : item;
        if (typeof name === "string") names.add(name);
      }
    }
  }
  return [...names].sort();
}

function Cell({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <div className="min-w-0 space-y-1">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="space-y-1 break-words">{children}</dd>
    </div>
  );
}

function ToolRow({
  name,
  results,
  checkedAt,
}: {
  name: string;
  /** The open results that name this tool. */
  results: readonly PlacedFinding[];
  checkedAt?: number;
}) {
  const [open, setOpen] = useState(false);
  const count = `${results.length} ${results.length === 1 ? "issue" : "issues"} found`;
  return (
    <>
      <tr className="border-t border-border">
        <td className={TABLE_CELL}>
          <code className="text-sm">{name}</code>
        </td>
        <td className={TABLE_CELL}>Not published</td>
        <td className={TABLE_CELL}>
          {checkedAt ? formatDistanceToNow(checkedAt, { addSuffix: true }) : "—"}
        </td>
        <td className={TABLE_CELL}>
          {results.length === 0 ? (
            <span className="text-muted-foreground">No issues found</span>
          ) : (
            <Button
              type="button"
              variant="link"
              size="sm"
              aria-expanded={open}
              aria-label={`${name}: ${count}`}
              onClick={() => setOpen(!open)}
              className="h-auto p-0 text-foreground dark:text-warning"
            >
              {count}
            </Button>
          )}
        </td>
      </tr>
      {open ? (
        <tr>
          <td colSpan={4} className="pb-3">
            <McpjamChecks findings={results} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

export function OpenAiMcp({
  step,
  values,
  findings,
  server,
  serverUrl,
  checkedAt,
  canRescan,
  onRescan,
  onAnswer,
}: {
  step: DirectoryFlowStep;
  values: AnswerValues;
  /** MCPJam's results on the tab. */
  findings: readonly PlacedFinding[];
  /** The MCP server the version's mcp.json declares. */
  server: PluginVersionServerComponent | undefined;
  /** The saved server's URL, which MCPJam grades. */
  serverUrl?: string;
  /** When the run of this version finished; absent before one. */
  checkedAt?: number;
  canRescan: boolean;
  onRescan: () => void;
  onAnswer: (key: string, value: DirectoryAnswerValue) => void;
}) {
  const blocks = step.layout?.blocks ?? [];
  const connect = blocks.find((block) => block.widget === "connect");
  const text = connect?.text ?? {};
  const url = step.fields.find((field) => field.control === "server");
  const token = step.fields.find((field) => field.control !== "server");
  const placedUnder = (key?: string) => findings.filter((entry) => entry.field === key);
  const domain = placedUnder(token?.key).filter((entry) => /^openai\.domain\./.test(entry.finding.id));
  const connection = findings.filter(
    (entry) => CONNECTION.test(entry.finding.id) && entry.field !== token?.key,
  );
  const tools = toolsOf(findings);
  const declared = url && values[url.key];
  const headers = (server?.headerRequirements ?? []).map((header) => header.name);
  const signIn = `sign-in ${server?.authenticationPolicy === "on_install" ? "at install" : "on first use"}`;
  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <div className="space-y-1">
          <h2 className="text-xl font-semibold">{connect?.heading}</h2>
          <p className="text-sm text-muted-foreground">{step.intro}</p>
        </div>
        <div className="rounded-xl border border-border p-4">
          <p className="flex items-center gap-2 text-lg">
            {server?.declaredName ?? "MCP server"} <Chip>Draft</Chip>
          </p>
          <dl className="mt-3 grid grid-cols-2 gap-4 text-sm lg:grid-cols-4">
            <Cell label="MCP URL">
              <p>{serverUrl ?? "—"}</p>
              {typeof declared === "string" && declared && declared !== serverUrl ? (
                <McpjamNote>
                  {`Your mcp.json names ${declared}, and MCPJam grades the saved server. Use the same URL in both.`}
                </McpjamNote>
              ) : null}
            </Cell>
            <Cell label={text.authentication}>
              {checkedAt && tools.length > 0 ? (
                <Chip tone="good">Authorized</Chip>
              ) : (
                <Chip>Not connected</Chip>
              )}
              {server ? (
                <p className="text-xs text-muted-foreground">
                  {`mcp.json: ${signIn}${headers.length > 0 ? `, headers ${headers.join(", ")}` : ""}`}
                </p>
              ) : null}
            </Cell>
            <Cell label="MCP key">
              <p>{server?.componentKey ?? "—"}</p>
            </Cell>
            <Cell label={text.domain}>
              {allHold(domain, checkedAt) ? (
                <Chip tone="good">
                  <Check aria-hidden="true" className="mr-1 inline size-3" />
                  {text.verified}
                </Chip>
              ) : (
                <Chip tone="warn">Not verified</Chip>
              )}
            </Cell>
          </dl>
          <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-3">
            <Button type="button" variant="outline" size="sm" disabled>
              <RefreshCw aria-hidden="true" />
              {text.reconnect}
            </Button>
            <Button type="button" variant="outline" size="sm" disabled={!canRescan} onClick={onRescan}>
              <RefreshCw aria-hidden="true" />
              {text.rescan}
            </Button>
            <McpjamNote>Reconnect the saved server on Connect.</McpjamNote>
          </div>
        </div>
        <McpjamChecks findings={connection} />
        {token ? (
          <PortalField
            field={token}
            value={values[token.key]}
            findings={placedUnder(token.key)}
            onChange={(value) => onAnswer(token.key, value)}
          />
        ) : null}
      </section>
      <section className="space-y-3">
        <h2 className="text-xl font-semibold">
          {blocks.find((block) => block.widget === "tools")?.heading}
        </h2>
        {tools.length === 0 ? (
          <McpjamNote>Run checks to read this server's tools and their annotations.</McpjamNote>
        ) : (
          <table className="w-full text-left text-sm">
            <thead>
              <tr>
                <th className={TABLE_HEAD}>Tool</th>
                <th className={TABLE_HEAD}>Availability</th>
                <th className={TABLE_HEAD}>Last checked</th>
                <th className={TABLE_HEAD}>
                  <McpjamMark />
                </th>
              </tr>
            </thead>
            <tbody>
              {tools.map((name) => (
                <ToolRow
                  key={name}
                  name={name}
                  results={findings.filter((entry) => openResult(entry) && mentions(entry, name))}
                  checkedAt={checkedAt}
                />
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
