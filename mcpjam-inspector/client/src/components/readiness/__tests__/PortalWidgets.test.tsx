/**
 * The parts of the portal's steps that are more than fields, drawn from the
 * flow's layout in the portal's words, with their fields drawn by the generic
 * field renderer and MCPJam's results under them.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  CLAUDE_CONNECTOR_FLOW,
  type DirectoryAnswerValue,
  type PlacedFinding,
} from "@mcpjam/sdk/browser";
import { PortalField } from "../PortalField";
import { PortalWidget } from "../PortalWidgets";

const flow = CLAUDE_CONNECTOR_FLOW;
const SERVER = { url: "https://mcp.example.com/mcp", name: "Sample server" };

function widget(
  stepId: string,
  name: string,
  values: Record<string, DirectoryAnswerValue> = {},
  findings: PlacedFinding[] = [],
) {
  const step = flow.steps.find((entry) => entry.id === stepId);
  const block = step?.layout?.blocks?.find((entry) => entry.widget === name);
  if (!step || !block) throw new Error(`No ${name} widget on ${stepId}`);
  const onChange = vi.fn();
  const view = render(
    <PortalWidget
      block={block}
      flow={flow}
      step={step}
      fields={step.fields.filter((field) => block.fields?.includes(field.key))}
      values={values}
      findings={findings}
      renderField={(field, label) => (
        <PortalField
          key={field.key}
          field={field}
          label={label}
          value={values[field.key]}
          findings={findings.filter((entry) => entry.field === field.key)}
          serverUrl={SERVER.url}
          serverName={SERVER.name}
          onChange={(value) => onChange(field.key, value)}
        />
      )}
    />,
  );
  return { onChange, container: view.container };
}

const toolResult: PlacedFinding = {
  finding: {
    id: "claude.tools.title-present",
    title: "Every tool carries a title annotation",
    lane: "directory-policy",
    class: "required",
    status: "satisfied",
    source: {},
    provenance: "wire",
    intrusiveness: "passive",
    evaluatedAt: "2026-01-01T00:00:00.000Z",
    engineVersion: "test",
  },
  step: "tools",
  evidenceStatus: "established",
};

describe("PortalWidget", () => {
  it("connector list: the portal's notice, a disabled add button, and the server to select", async () => {
    const { onChange } = widget("connection", "connector-picker");
    expect(
      screen.getByText("This form is for remote MCP servers only."),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Add custom connector" }),
    ).toBeDisabled();
    expect(
      screen.getByText("Choose the server in the bar above."),
    ).toBeVisible();
    const list = screen.getByRole("group", {
      name: "Or choose a connector you’ve already added:",
    });
    expect(list).toHaveTextContent("Sample server");
    expect(list).toHaveTextContent(SERVER.url);
    await userEvent.click(screen.getByRole("button", { name: "Select" }));
    expect(onChange).toHaveBeenCalledWith("connection.serverUrl", SERVER.url);
    expect(
      screen.getByText("Servers already in the directory aren’t shown."),
    ).toBeVisible();
  });

  it("tool list: the portal's empty line until a server is selected", () => {
    widget("tools", "tool-list");
    expect(
      screen.getByText(
        "No server selected. Go back to the Connection step and pick a server.",
      ),
    ).toBeVisible();
  });

  it("tool list: asks for a run until MCPJam has results for the tools", () => {
    const selected = { "connection.serverUrl": SERVER.url };
    widget("tools", "tool-list", selected);
    expect(
      screen.getByText(
        "Run checks to read this server's tools and their annotations.",
      ),
    ).toBeVisible();
  });

  it("tool list: draws nothing over MCPJam's results", () => {
    const selected = { "connection.serverUrl": SERVER.url };
    const { container } = widget("tools", "tool-list", selected, [toolResult]);
    expect(container).toBeEmptyDOMElement();
  });

  it("icon: a button that opens the custom icon URL and focuses it", async () => {
    const { onChange } = widget("listing", "icon");
    expect(screen.queryByRole("textbox")).toBeNull();
    await userEvent.click(
      screen.getByRole("button", { name: "Add custom icon URL" }),
    );
    const input = screen.getByRole("textbox", { name: "Icon" });
    expect(input).toHaveFocus();
    await userEvent.type(input, "h");
    expect(onChange).toHaveBeenLastCalledWith("listing.iconUrl", "h");
  });

  it("icon: an icon URL already saved shows its box", () => {
    widget("listing", "icon", {
      "listing.iconUrl": "https://example.com/icon.png",
    });
    expect(screen.getByRole("textbox", { name: "Icon" })).toHaveValue(
      "https://example.com/icon.png",
    );
  });

  it("listing preview: the portal's placeholders, then the answers", () => {
    widget("listing", "listing-preview");
    expect(screen.getByText("How it reads in the directory")).toBeVisible();
    expect(screen.getByText("Your server’s name")).toBeVisible();
    expect(screen.getByText("One-liner appears here")).toBeVisible();
  });

  it("listing preview: shows the name and one-liner as typed", () => {
    widget("listing", "listing-preview", {
      "listing.name": "Sample",
      "listing.oneLiner": "Runs sample checks.",
    });
    expect(screen.getByText("Sample")).toBeVisible();
    expect(screen.getByText("Runs sample checks.")).toBeVisible();
  });

  it("OAuth card: the OAuth client inside it, the header buttons disabled", async () => {
    const { onChange } = widget("authentication", "oauth-sign-in", {
      "authentication.oauthClient": "dcr",
    });
    expect(screen.getByText("OAuth sign-in")).toBeVisible();
    expect(
      screen.getByRole("radio", { name: /Dynamic Client Registration/ }),
    ).toBeChecked();
    await userEvent.click(
      screen.getByRole("radio", { name: /Client ID Metadata Document/ }),
    );
    expect(onChange).toHaveBeenCalledWith("authentication.oauthClient", "cimd");
    expect(screen.getByRole("button", { name: "Add header" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Add static headers" }),
    ).toBeDisabled();
    expect(
      screen.getByText("This rehearsal does not include request headers."),
    ).toBeVisible();
  });
});
