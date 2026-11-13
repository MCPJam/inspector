/**
 * The parts of a portal step that are more than fields, drawn from the
 * flow's layout in the portal's own words (`block.text`): Claude's connector
 * list, tool list, icon button, listing preview and OAuth card. A widget that
 * holds fields draws them with the generic field renderer (`renderField`).
 *
 * The portal's buttons that add what MCPJam does not rehearse (a connector,
 * request headers) stay visible, disabled, with MCPJam's reason beside them.
 */
import { useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { Info, Plus } from "lucide-react";
import type {
  DirectoryFlow,
  DirectoryFlowField,
  DirectoryFlowStep,
  DirectoryLayoutBlock,
  PlacedFinding,
} from "@mcpjam/sdk/browser";
import { Button } from "@mcpjam/design-system/button";
import type { AnswerValues } from "@/hooks/use-directory-submission";
import { McpjamChecks, McpjamMark } from "./McpjamChecks";
import { portalFieldId } from "./PortalField";

const NOTE = "text-sm text-muted-foreground";

export interface PortalWidgetProps {
  block: DirectoryLayoutBlock;
  flow: DirectoryFlow;
  step: DirectoryFlowStep;
  /** The fields the block names. */
  fields: readonly DirectoryFlowField[];
  values: AnswerValues;
  /** MCPJam's results on this step. */
  findings: readonly PlacedFinding[];
  renderField: (field: DirectoryFlowField, label?: string) => ReactNode;
}

const textOf = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";

function McpjamNote({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-center gap-2 text-xs text-muted-foreground">
      <McpjamMark />
      {children}
    </p>
  );
}

/** The portal shows a button until someone adds a custom icon URL. */
function CustomIcon({
  field,
  added,
  add,
  findings,
  children,
}: {
  field: DirectoryFlowField;
  added: boolean;
  add?: string;
  findings: readonly PlacedFinding[];
  children: ReactNode;
}) {
  // Opened stays open, so clearing the URL does not hide the box mid-edit.
  const [open, setOpen] = useState(added);
  if (open || added) return <>{children}</>;
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">{field.label}</p>
      <p className={NOTE}>{field.helper}</p>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={() => {
          flushSync(() => setOpen(true));
          document.getElementById(portalFieldId(field.key))?.focus();
        }}
      >
        {add}
      </Button>
      <McpjamChecks
        findings={findings.filter((entry) => entry.field === field.key)}
      />
    </div>
  );
}

export function PortalWidget({
  block,
  flow,
  step,
  fields,
  values,
  findings,
  renderField,
}: PortalWidgetProps) {
  const text = block.text ?? {};
  const all = () => fields.map((field) => renderField(field));
  switch (block.widget) {
    case "connector-picker":
      return (
        <div className="space-y-5">
          <div className="flex gap-3 rounded-xl border border-border px-4 py-3 text-sm">
            <Info
              aria-hidden="true"
              className="mt-0.5 size-4 shrink-0 text-muted-foreground"
            />
            <p>
              <span className="font-medium">{text.notice}</span>
              <span className="block text-muted-foreground">
                {text.noticeDetail}
              </span>
            </p>
          </div>
          <div className="space-y-2">
            <Button type="button" variant="secondary" disabled>
              {text.add}
            </Button>
            <p className={NOTE}>{text.addHelper}</p>
            <McpjamNote>Choose the server in the bar above.</McpjamNote>
          </div>
          {fields.map((field) =>
            renderField(
              field,
              field.control === "server" ? text.choose : undefined,
            ),
          )}
        </div>
      );
    case "tool-list": {
      const server = flow.steps
        .flatMap((entry) => entry.fields)
        .find((field) => field.control === "server");
      if (server && !textOf(values[server.key])) {
        return <p className="text-sm">{text.empty}</p>;
      }
      return findings.length > 0 ? null : (
        <McpjamNote>
          Run checks to read this server's tools and their annotations.
        </McpjamNote>
      );
    }
    case "icon":
      return fields.map((field) => (
        <CustomIcon
          key={field.key}
          field={field}
          added={Boolean(textOf(values[field.key]))}
          add={text.add}
          findings={findings}
        >
          {renderField(field)}
        </CustomIcon>
      ));
    case "listing-preview":
      return (
        <div className="space-y-2">
          <p className={NOTE}>{text.title}</p>
          <div className="flex max-w-md items-center gap-3 rounded-xl bg-card px-4 py-3">
            <span
              aria-hidden="true"
              className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border text-sm text-muted-foreground"
            >
              ?
            </span>
            <span className="min-w-0">
              <span className="block truncate text-sm">
                {textOf(values[`${step.id}.name`]) || text.name}
              </span>
              <span className="block truncate text-xs text-muted-foreground">
                {textOf(values[`${step.id}.oneLiner`]) || text.oneLiner}
              </span>
            </span>
          </div>
        </div>
      );
    case "oauth-sign-in":
      return (
        <div className="space-y-3">
          <div className="space-y-4 rounded-xl bg-card p-4">
            <p className="text-sm font-medium">{text.title}</p>
            {all()}
            <div className="space-y-2">
              <p className="text-sm font-medium">{text.headers}</p>
              <Button type="button" variant="secondary" size="sm" disabled>
                <Plus aria-hidden="true" />
                {text.addHeader}
              </Button>
              <p className={NOTE}>{text.headersHelper}</p>
            </div>
          </div>
          <Button type="button" variant="secondary" size="sm" disabled>
            <Plus aria-hidden="true" />
            {text.addStaticHeaders}
          </Button>
          <McpjamNote>
            This rehearsal does not include request headers.
          </McpjamNote>
        </div>
      );
    default:
      // The review page's submit block, drawn by the frame, or a widget this
      // page does not know: its fields alone, so no answer goes missing.
      return all();
  }
}
