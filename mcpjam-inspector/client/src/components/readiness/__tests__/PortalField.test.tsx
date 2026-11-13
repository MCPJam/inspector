/**
 * The generic field renderer: every control a flow can name, drawn from the
 * flow definition and answering with the value shape the API stores.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  CLAUDE_CONNECTOR_FLOW,
  directoryFlowField,
  type DirectoryAnswerValue,
  type DirectoryFlowField,
  type PlacedFinding,
} from "@mcpjam/sdk/browser";
import { PortalField, type PortalFieldProps } from "../PortalField";

function claudeField(key: string): DirectoryFlowField {
  const field = directoryFlowField(CLAUDE_CONNECTOR_FLOW, key);
  if (!field) throw new Error(`The Claude flow has no field ${key}`);
  return field;
}

function draw(
  field: DirectoryFlowField,
  value?: DirectoryAnswerValue,
  props: Partial<PortalFieldProps> = {},
) {
  const onChange = vi.fn();
  const view = render(
    <PortalField field={field} value={value} onChange={onChange} {...props} />,
  );
  return { onChange, ...view };
}

const options = [
  { value: "alpha", label: "Alpha" },
  { value: "beta", label: "Beta" },
];

describe("PortalField", () => {
  it("text: the portal's label, placeholder and counter, red past the limit", async () => {
    const field = claudeField("listing.oneLiner");
    const { onChange, rerender } = draw(field, "");
    const input = screen.getByLabelText(/One-liner/);
    expect(input).toHaveAttribute(
      "placeholder",
      "A short tagline for your MCP server",
    );
    await userEvent.type(input, "A");
    expect(onChange).toHaveBeenLastCalledWith("A");

    rerender(
      <PortalField field={field} value={"x".repeat(201)} onChange={onChange} />,
    );
    expect(screen.getByText("201 / 200 characters")).toHaveClass(
      "text-destructive",
    );
    expect(screen.getByLabelText(/One-liner/)).toHaveAttribute(
      "aria-invalid",
      "true",
    );
  });

  it("textarea: answers with the text", () => {
    const { onChange } = draw(claudeField("listing.description"), "");
    fireEvent.change(screen.getByLabelText(/Description/), {
      target: { value: "Runs suites." },
    });
    expect(onChange).toHaveBeenCalledWith("Runs suites.");
  });

  it("secret: a secret's name, typed as text", () => {
    const field = {
      key: "reviewer.password",
      label: "Reviewer password secret",
      control: "secret",
      errors: {},
    } satisfies DirectoryFlowField;
    const { onChange } = draw(field, "");
    fireEvent.change(screen.getByLabelText("Reviewer password secret"), {
      target: { value: "REVIEWER_PASSWORD" },
    });
    expect(onChange).toHaveBeenCalledWith("REVIEWER_PASSWORD");
  });

  it("select: answers with the option's value, not its label", async () => {
    const field = {
      key: "listing.kind",
      label: "Kind",
      control: "select",
      placeholder: "Choose one",
      options,
      errors: {},
    } satisfies DirectoryFlowField;
    const { onChange } = draw(field, "");
    await userEvent.click(screen.getByRole("combobox"));
    await userEvent.click(screen.getByRole("option", { name: "Beta" }));
    expect(onChange).toHaveBeenCalledWith("beta");
  });

  it("multi-select without options: free entry, up to the limit", async () => {
    // The portal's category list was never captured.
    const field = claudeField("listing.categories");
    const { onChange, rerender } = draw(field, []);
    const entry = () => screen.getByRole("textbox", { name: /Categories/ });
    await userEvent.type(entry(), "Developer tools{Enter}");
    expect(onChange).toHaveBeenLastCalledWith(["Developer tools"]);

    rerender(
      <PortalField
        field={field}
        value={["Developer tools"]}
        onChange={onChange}
      />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Remove Developer tools" }),
    );
    expect(onChange).toHaveBeenLastCalledWith([]);

    rerender(
      <PortalField
        field={field}
        value={["a", "b", "c", "d", "e"]}
        onChange={onChange}
      />,
    );
    expect(entry()).toBeDisabled();
  });

  it("multi-select with options: ticks option values", async () => {
    const field = {
      key: "listing.tags",
      label: "Tags",
      control: "multi-select",
      options,
      errors: {},
    } satisfies DirectoryFlowField;
    const { onChange } = draw(field, ["alpha"]);
    expect(screen.getByRole("checkbox", { name: "Alpha" })).toBeChecked();
    await userEvent.click(screen.getByRole("checkbox", { name: "Beta" }));
    expect(onChange).toHaveBeenCalledWith(["alpha", "beta"]);
  });

  it("radio: shows the default and answers with an option value", async () => {
    const { onChange } = draw(claudeField("useCases.access"), "read-only");
    expect(screen.getByRole("radio", { name: /Read only/ })).toBeChecked();
    await userEvent.click(
      screen.getByRole("radio", { name: /Read and write/ }),
    );
    expect(onChange).toHaveBeenCalledWith("read-write");
  });

  it("radio-cards: answers with an option value", async () => {
    const { onChange } = draw(claudeField("dataHandling.apiOwnership"), "own");
    await userEvent.click(
      screen.getByRole("radio", { name: /We proxy a partner’s API/ }),
    );
    expect(onChange).toHaveBeenCalledWith("partner-proxy");
  });

  it("checkbox: the label sits beside the box and answers true or false", async () => {
    const { onChange } = draw(claudeField("connection.differentUrls"), false);
    await userEvent.click(
      screen.getByRole("checkbox", { name: "Users connect to different URLs" }),
    );
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("checkbox-group: adds and removes option values", async () => {
    const field = claudeField("compliance.acknowledgments");
    const [first, second] = field.options ?? [];
    const { onChange } = draw(field, [first.value]);
    await userEvent.click(screen.getByRole("checkbox", { name: second.label }));
    expect(onChange).toHaveBeenLastCalledWith([first.value, second.value]);
    await userEvent.click(screen.getByRole("checkbox", { name: first.label }));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it("pairs: one row per use case, without trailing empty rows", () => {
    const { onChange } = draw(claudeField("useCases.pairs"), []);
    expect(screen.getAllByRole("textbox")).toHaveLength(6);
    fireEvent.change(screen.getByLabelText("Use case 2"), {
      target: { value: "Run a suite" },
    });
    expect(onChange).toHaveBeenLastCalledWith([
      { useCase: "", examplePrompt: "" },
      { useCase: "Run a suite", examplePrompt: "" },
    ]);
  });

  it("pairs: clearing the last row drops it", () => {
    const { onChange } = draw(claudeField("useCases.pairs"), [
      { useCase: "Run a suite", examplePrompt: "" },
    ]);
    fireEvent.change(screen.getByLabelText("Use case 1"), {
      target: { value: "" },
    });
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it("server: selects the submission's server URL", async () => {
    const field = claudeField("connection.serverUrl");
    const serverUrl = "https://mcp.example.com/mcp";
    const { onChange, rerender } = draw(field, undefined, { serverUrl });
    await userEvent.click(screen.getByRole("button", { name: "Select" }));
    expect(onChange).toHaveBeenCalledWith(serverUrl);

    rerender(
      <PortalField
        field={field}
        value={serverUrl}
        serverUrl={serverUrl}
        onChange={onChange}
      />,
    );
    expect(screen.getByText("Selected")).toBeInTheDocument();
  });

  it("shows the portal's error line, and the review-only author has no mark", () => {
    draw(claudeField("listing.name"), "", {
      issue: {
        key: "listing.name",
        step: "listing",
        code: "required",
        message: "This field is required",
      },
    });
    expect(screen.getByText("Error: This field is required")).toBeVisible();
    draw(claudeField("listing.authorName"), "");
    expect(screen.getByText("Author name")).not.toHaveTextContent("required");
  });

  it("puts MCPJam's results for the field under it", () => {
    const finding = {
      finding: {
        id: "claude.endpoint.https",
        title: "The server URL uses https",
        lane: "runtime-compatibility",
        class: "required",
        status: "violated",
        remediation: "Serve the endpoint over https.",
        source: {},
        provenance: "wire",
        intrusiveness: "passive",
        evaluatedAt: "2026-01-01T00:00:00.000Z",
        engineVersion: "test",
      },
      step: "connection",
      field: "connection.serverUrl",
      evidenceStatus: "established",
    } satisfies PlacedFinding;
    draw(claudeField("connection.serverUrl"), undefined, {
      findings: [finding],
    });
    expect(screen.getByText("MCPJam")).toBeVisible();
    expect(screen.getByText("The server URL uses https")).toBeVisible();
    expect(screen.getByText("Blocker")).toBeVisible();
    expect(screen.getByText("Established")).toBeVisible();
    expect(screen.getByText("Verified on your server")).toBeVisible();
    expect(screen.getByText("Serve the endpoint over https.")).toBeVisible();
  });
});
