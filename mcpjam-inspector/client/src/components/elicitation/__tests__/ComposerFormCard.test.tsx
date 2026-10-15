import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ComposerFormCard } from "../ComposerFormCard";
import {
  compileComposerForm,
  logComposerFormDiagnostics,
} from "../form-diagnostics";
import { useTrafficLogStore } from "@/stores/traffic-log-store";
import { PluginDescribedError } from "@/shared/plugin-operation";
import {
  compilePluginForm,
  type PluginFormProfile,
} from "@/shared/plugin-extensions/form-plan";

const profile: PluginFormProfile = {
  fileResources: true,
  origin: "server",
  userResources: false,
  previews: false,
};

function card(
  schema: unknown,
  onRespond = vi.fn(async (..._args: unknown[]) => {}),
) {
  const plan = compilePluginForm(schema, profile);
  render(
    <ComposerFormCard
      requestId="request-1"
      title="Review the part"
      serverName="Parts Library"
      plan={plan}
      onRespond={onRespond}
    />,
  );
  return onRespond;
}

const steps = {
  type: "object",
  required: ["name"],
  properties: {
    name: { type: "string", title: "Name" },
    note: { type: "string", title: "Note" },
    size: {
      type: "string",
      title: "Size",
      oneOf: [
        { const: "s", title: "Small" },
        { const: "m", title: "Medium" },
        { const: "l", title: "Large" },
      ],
    },
  },
};

describe("composer form card", () => {
  it("heads the card with the asking plugin's icon, else its server's", () => {
    const plan = compilePluginForm(
      { type: "object", properties: { name: { type: "string" } } },
      profile,
    );
    const header = () =>
      screen.getByRole("heading").parentElement!.querySelector("img");
    const { rerender } = render(
      <ComposerFormCard
        requestId="request-1"
        title="Review the part"
        serverName="Parts Library"
        icons={{
          pluginIcons: {
            composerIcon: {
              url: "https://cdn.test/composer.png",
              contentType: "image/png",
            },
          },
          serverIcons: [{ src: "https://cdn.test/server.png" }],
        }}
        plan={plan}
        onRespond={vi.fn(async () => {})}
      />,
    );
    expect(header()).toHaveAttribute("src", "https://cdn.test/composer.png");
    rerender(
      <ComposerFormCard
        requestId="request-1"
        title="Review the part"
        serverName="Parts Library"
        icons={{ serverIcons: [{ src: "https://cdn.test/server.png" }] }}
        plan={plan}
        onRespond={vi.fn(async () => {})}
      />,
    );
    expect(header()).toHaveAttribute("src", "https://cdn.test/server.png");
  });
  it("submits a single field with one Continue and the keyboard shortcut", async () => {
    const respond = card({
      type: "object",
      required: ["name"],
      properties: { name: { type: "string", title: "Name" } },
    });
    expect(screen.getByRole("region", { name: "Review the part" })).toBe(
      document.activeElement,
    );
    expect(screen.queryByText(/of 1/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Skip for now" })).toBeNull();
    fireEvent.change(screen.getByLabelText(/Name/), {
      target: { value: "Bolt" },
    });
    fireEvent.keyDown(screen.getByLabelText(/Name/), {
      key: "Enter",
      metaKey: true,
    });
    await waitFor(() =>
      expect(respond).toHaveBeenCalledWith("accept", { name: "Bolt" }),
    );
  });

  it("walks one question per step, skips only optional fields and omits them", async () => {
    const respond = card(steps);
    expect(screen.getByText("1 of 3")).toBeInTheDocument();
    // Required: no Skip; an empty answer is still an answer.
    expect(screen.queryByRole("button", { name: "Skip for now" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("2 of 3")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Note/), {
      target: { value: "dropped" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    expect(screen.getByText("3 of 3")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "Medium" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() =>
      expect(respond).toHaveBeenCalledWith("accept", { name: "", size: "m" }),
    );
  });

  it("blocks Next on a value the field forbids and pages back", () => {
    const respond = card({
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string", title: "Name", minLength: 2 },
        note: { type: "string", title: "Note" },
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("1 of 2")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "This answer doesn't fit what was asked.",
    );
    expect(screen.queryByText(/minLength|pattern|schema/i)).toBeNull();
    fireEvent.change(screen.getByLabelText(/Name/), {
      target: { value: "Ok" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Next question" }));
    expect(screen.getByText("2 of 2")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Previous question" }));
    expect(screen.getByLabelText(/Name/)).toHaveValue("Ok");
    expect(respond).not.toHaveBeenCalled();
  });

  it("skipping the last optional field submits without it", async () => {
    const respond = card({
      type: "object",
      properties: { note: { type: "string", title: "Note" } },
    });
    fireEvent.change(screen.getByLabelText(/Note/), {
      target: { value: "typed then skipped" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    await waitFor(() => expect(respond).toHaveBeenCalledWith("accept", {}));
  });

  it.each([
    ["Decline", "decline"],
    ["Close", "cancel"],
  ])("%s sends %s without content", async (name, action) => {
    const respond = card(steps);
    fireEvent.change(screen.getByLabelText(/Name/), {
      target: { value: "not sent" },
    });
    fireEvent.click(screen.getByRole("button", { name }));
    await waitFor(() =>
      expect(respond).toHaveBeenCalledWith(action, undefined),
    );
  });

  it("selects options with number keys outside text inputs", () => {
    card({
      type: "object",
      properties: {
        size: {
          type: "string",
          title: "Size",
          oneOf: [
            { const: "s", title: "Small" },
            { const: "m", title: "Medium" },
          ],
        },
      },
    });
    const region = screen.getByRole("region", { name: "Review the part" });
    fireEvent.keyDown(region, { key: "2" });
    expect(screen.getByRole("radio", { name: "Medium" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("keeps the card and answers after a failed send", async () => {
    let reject!: (error: Error) => void;
    const respond = vi.fn(
      () =>
        new Promise<void>((_, no) => {
          reject = no;
        }),
    );
    card(
      {
        type: "object",
        properties: { note: { type: "string", title: "Note" } },
      },
      respond,
    );
    fireEvent.change(screen.getByLabelText(/Note/), {
      target: { value: "kept" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(respond).toHaveBeenCalledTimes(1);
    await act(async () => reject(new Error("synthetic")));
    expect(screen.getByRole("alert")).toHaveTextContent("couldn't be sent");
    expect(screen.getByLabelText(/Note/)).toHaveValue("kept");
    expect(screen.getByRole("button", { name: "Continue" })).not.toBeDisabled();
  });

  it("says why a skipped last step wasn't sent and sends the same answers again", async () => {
    const respond = vi
      .fn()
      .mockRejectedValueOnce(
        new PluginDescribedError(
          "MCPJam didn't confirm the answer within 30 seconds.",
          "PLUGIN_FORM_SUBMIT_TIMEOUT",
        ),
      )
      .mockResolvedValueOnce(undefined);
    card(steps, respond);
    fireEvent.change(screen.getByLabelText(/Name/), {
      target: { value: "kept" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "MCPJam didn't confirm the answer within 30 seconds.",
    );
    // Same step, every control usable again.
    expect(screen.getByText("3 of 3")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Skip for now" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Close" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    await waitFor(() => expect(respond).toHaveBeenCalledTimes(2));
    expect(respond.mock.calls[1]).toEqual(respond.mock.calls[0]);
    expect(respond.mock.calls[0]).toEqual(["accept", { name: "kept" }]);
  });

  it("names the field and reason when a form can't be shown", async () => {
    const compiled = compileComposerForm(
      {
        type: "object",
        properties: {
          name: { type: "string" },
          references: {
            type: "array",
            title: "CAD references",
            items: { type: "string", format: "uri" },
            "x-openai-input": {
              type: "resource",
              options: [],
              selection: "implicit",
            },
          },
        },
      },
      { ...profile, fileResources: false, origin: "mcp-app" },
    );
    expect(compiled.unsupported).toMatchObject({
      field: "CAD references",
      code: "PLUGIN_FORM_WEB_UPLOAD_UNSUPPORTED",
    });
    const respond = vi.fn(async () => {});
    render(
      <ComposerFormCard
        requestId="unsupported"
        title="Choose CAD references"
        serverName="Parts Library"
        unsupported={compiled.unsupported}
        onRespond={respond}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "CAD references: Adding your own files isn't available in forms opened from an App while this client's File resources extension is off.",
    );
    expect(screen.queryByRole("textbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Decline" }));
    await waitFor(() =>
      expect(respond).toHaveBeenCalledWith("decline", undefined),
    );
  });

  it("explains a server default that isn't one of the offered choices", () => {
    const compiled = compileComposerForm(
      {
        type: "object",
        properties: {
          part: {
            type: "string",
            title: "Part",
            format: "uri",
            default: "fixture://missing",
            "x-openai-input": {
              type: "resource",
              options: [{ uri: "fixture://one", name: "One" }],
            },
          },
        },
      },
      profile,
    );
    expect(compiled.unsupported).toMatchObject({
      field: "Part",
      reason: "The server's default isn't one of the offered choices.",
    });
    // The shared diagnostic names the field for Logs.
    expect(compiled.unsupported?.diagnostic).toMatchObject({
      code: "PLUGIN_FORM_UNSUPPORTED",
      details: { field: "part" },
    });
  });

  it("explains a selection mode on a field that takes one choice", () => {
    const compiled = compileComposerForm(
      {
        type: "object",
        properties: {
          part: {
            type: "string",
            title: "Part",
            format: "uri",
            "x-openai-input": {
              type: "resource",
              selection: "explicit",
              options: [{ uri: "fixture://one", name: "One" }],
            },
          },
        },
      },
      profile,
    );
    expect(compiled.unsupported).toMatchObject({
      field: "Part",
      reason:
        "The server set a selection mode on a field that takes one choice, which isn't allowed.",
    });
  });

  it("names an unknown input type in Logs and refuses the whole form", () => {
    const compiled = compileComposerForm(
      {
        type: "object",
        properties: {
          name: { type: "string", title: "Name" },
          span: {
            type: "string",
            title: "Dates",
            "x-openai-input": { type: "date-range" },
          },
        },
      },
      profile,
    );
    expect(compiled.plan).toBeUndefined();
    expect(compiled.unsupported).toMatchObject({
      field: "Dates",
      reason: "It uses an input this client doesn't support.",
    });
    expect(compiled.unsupported?.diagnostic.details).toMatchObject({
      field: "span",
      reason: 'It asks for a "date-range" input, which this client doesn\'t support.',
    });
  });

  it("shows a form without previews when this host can't open them, with one Logs entry", () => {
    useTrafficLogStore.getState().clear();
    const compiled = compileComposerForm(
      {
        type: "object",
        properties: {
          part: {
            type: "string",
            format: "uri",
            "x-openai-input": {
              type: "resource",
              options: [
                {
                  uri: "fixture://one",
                  name: "One",
                  _meta: {
                    "openai/preview": {
                      target: {
                        type: "resource_link",
                        uri: "fixture://one",
                        name: "One",
                      },
                    },
                  },
                },
              ],
            },
          },
        },
      },
      profile,
    );
    expect(compiled.unsupported).toBeUndefined();
    const field = compiled.plan!.fields[0]!.field as {
      "x-openai-input": { options: { _meta?: Record<string, unknown> }[] };
    };
    expect(field["x-openai-input"].options[0]?._meta).toBeUndefined();
    // The plan drops the preview and says so; logging the same plan twice
    // (a re-render) keeps one row.
    logComposerFormDiagnostics(compiled, { serverId: "parts" });
    logComposerFormDiagnostics(compiled, { serverId: "parts" });
    const rows = useTrafficLogStore
      .getState()
      .mcpServerItems.filter((row) => row.serverId === "parts");
    expect(rows.map((row) => row.method)).toEqual([
      "plugin-extensions/PLUGIN_FORM_PREVIEW_DROPPED",
    ]);
  });
});
