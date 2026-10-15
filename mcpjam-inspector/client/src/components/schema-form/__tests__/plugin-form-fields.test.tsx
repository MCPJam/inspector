import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ElicitationDialog } from "../../ElicitationDialog";
import { PluginFormFields, type PluginFormPorts } from "../PluginFormFields";
import {
  compilePluginForm,
  initialPluginFormValues,
} from "@/shared/plugin-extensions/form-plan";
import { PluginDescribedError } from "@/shared/plugin-operation";
const profile = {
  fileResources: true,
  origin: "server",
  userResources: false,
  previews: false,
} as const;
const schema = {
  type: "object",
  properties: {
    part: {
      type: "string",
      oneOf: [
        {
          const: "bolt",
          title: "Bolt",
          description: "A bolt",
          "x-openai-thumbnail": { src: "https://invalid.example/bolt.png" },
        },
        { const: "washer", title: "Washer", description: "A washer" },
      ],
    },
    accessories: {
      type: "array",
      items: {
        type: "string",
        minLength: 2,
        "x-openai-suggestions": [
          { const: "washer", title: "Washer suggestion" },
        ],
      },
    },
    resource: {
      type: "string",
      format: "uri",
      "x-openai-input": {
        type: "resource",
        options: [{ uri: "fixture://one", name: "Resource One" }],
      },
    },
  },
};
const request = {
  requestId: "owned-one",
  message: "Choose parts",
  schema,
  timestamp: "2026-10-02T06:00:00Z",
  serverId: "fixture",
};
describe("shared plugin form editor", () => {
  it("preserves an offered single resource when the native upload picker is cancelled", async () => {
    const chooseResources = vi.fn(async () => []);
    const raw = {
      type: "object",
      properties: {
        file: {
          type: "string",
          format: "uri",
          "x-openai-input": {
            type: "resource",
            options: [{ uri: "fixture://selected", name: "Selected file" }],
            userOptions: { kind: "file" },
          },
        },
      },
    };
    const plan = compilePluginForm(raw, { ...profile, userResources: true });
    const changed = vi.fn();
    render(
      <PluginFormFields
        requestId="native-cancel"
        plan={plan}
        ports={{ chooseResources }}
        values={{ file: "fixture://selected" }}
        errors={{}}
        onChange={changed}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Choose files" }));
    await waitFor(() => expect(chooseResources).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Choose files" }),
      ).not.toBeDisabled(),
    );
    expect(changed).not.toHaveBeenCalled();
    expect(screen.getByRole("radio", { name: "Selected file" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("retains a calendar input event through another control and submits the date", async () => {
    const respond = vi.fn(async () => {});
    render(
      <ElicitationDialog
        elicitationRequest={{
          ...request,
          schema: {
            type: "object",
            properties: {
              date: { type: "string", format: "date" },
              enabled: { type: "boolean" },
            },
          },
        }}
        pluginForm={{ profile }}
        onResponse={respond}
      />,
    );
    const date = screen.getByLabelText("date") as HTMLInputElement;
    // Calendar/autofill integrations can update the element before dispatching
    // their input event. Keep the controlled value in sync on that event.
    date.value = "2026-10-04";
    fireEvent.input(date);
    fireEvent.click(screen.getByRole("checkbox"));
    expect(date.value).toBe("2026-10-04");
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    await waitFor(() =>
      expect(respond).toHaveBeenCalledWith("accept", {
        date: "2026-10-04",
        enabled: true,
      }),
    );
  });

  it("answers a date-time field in RFC 3339 so it satisfies its format", async () => {
    const respond = vi.fn(async () => {});
    render(
      <ElicitationDialog
        elicitationRequest={{
          ...request,
          schema: {
            type: "object",
            required: ["at"],
            properties: {
              at: {
                type: "string",
                format: "date-time",
                default: "2026-10-05T13:00:00Z",
              },
            },
          },
        }}
        pluginForm={{ profile }}
        onResponse={respond}
      />,
    );
    const at = screen.getByLabelText(/^at/) as HTMLInputElement;
    expect(at.type).toBe("datetime-local");
    // The default shows in local time, as the picker expects.
    expect(new Date(at.value).toISOString()).toBe("2026-10-05T13:00:00.000Z");
    fireEvent.change(at, { target: { value: "2026-10-06T09:30" } });
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    await waitFor(() =>
      expect(respond).toHaveBeenCalledWith("accept", {
        at: new Date("2026-10-06T09:30").toISOString().replace(".000Z", "Z"),
      }),
    );
  });

  it("renders enum arrays as typed choices and preserves allowed empty string array items", async () => {
    const respond = vi.fn(async () => {});
    render(
      <ElicitationDialog
        elicitationRequest={{
          ...request,
          schema: {
            type: "object",
            required: ["choices", "custom"],
            properties: {
              choices: {
                type: "array",
                items: { type: "string", enum: ["left", "right"] },
              },
              custom: { type: "array", minItems: 1, items: { type: "string" } },
            },
          },
        }}
        pluginForm={{ profile }}
        onResponse={respond}
      />,
    );
    expect(screen.queryByRole("textbox", { name: "Add choices" })).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: "right" }));
    // An allowed empty entry is added from the inline row and listed checked.
    fireEvent.click(screen.getByRole("button", { name: "Add", exact: true }));
    expect(
      screen.getByRole("checkbox", { name: "Empty value" }),
    ).toHaveAttribute("aria-checked", "true");
    fireEvent.click(
      screen.getByRole("button", { name: "Accept", exact: true }),
    );
    await waitFor(() =>
      expect(respond).toHaveBeenCalledWith("accept", {
        choices: ["right"],
        custom: [""],
      }),
    );
  });
  it("submits typed choices, suggestions, custom strings and an offered resource through the existing dialog", async () => {
    const respond = vi.fn(async () => {});
    render(
      <ElicitationDialog
        elicitationRequest={request}
        pluginForm={{ profile }}
        onResponse={respond}
      />,
    );
    fireEvent.click(screen.getByRole("radio", { name: "Bolt A bolt" }));
    // Every titled choice gets the image layout once any has a thumbnail.
    expect(
      screen
        .getByRole("radiogroup", { name: "part" })
        .querySelectorAll('[data-thumbnail="row"]'),
    ).toHaveLength(2);
    fireEvent.error(document.querySelector("img")!);
    expect(document.querySelector("img")).toBeNull();
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Washer suggestion" }),
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Add accessories" }), {
      target: { value: "custom-spacer" },
    });
    fireEvent.keyDown(
      screen.getByRole("textbox", { name: "Add accessories" }),
      { key: "Enter" },
    );
    // The custom entry joins the same list as a checked row.
    expect(
      screen.getByRole("checkbox", { name: "custom-spacer" }),
    ).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("radio", { name: "Resource One" }));
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    await waitFor(() =>
      expect(respond).toHaveBeenCalledWith("accept", {
        part: "bolt",
        accessories: ["washer", "custom-spacer"],
        resource: "fixture://one",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    expect(respond).toHaveBeenCalledTimes(1);
  });
  it("rejects a whole unavailable form without rendering partial fields, and declines without content", async () => {
    const respond = vi.fn(async () => {});
    render(
      <ElicitationDialog
        elicitationRequest={{
          ...request,
          schema: {
            ...schema,
            properties: {
              ...schema.properties,
              future: { type: "string", "x-openai-input": { type: "future" } },
            },
          },
        }}
        pluginForm={{ profile }}
        onResponse={respond}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("cannot support");
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByRole("button", { name: "Accept" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Decline" }));
    await waitFor(() =>
      expect(respond).toHaveBeenCalledWith("decline", undefined),
    );
  });
  it("retains the form after a failed submit and serializes pending response attempts", async () => {
    let reject!: (error: Error) => void;
    const respond = vi.fn(
      () =>
        new Promise<void>((_, no) => {
          reject = no;
        }),
    );
    render(
      <ElicitationDialog
        elicitationRequest={request}
        pluginForm={{ profile }}
        onResponse={respond}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    expect(respond).toHaveBeenCalledTimes(1);
    await act(async () => reject(new Error("synthetic lost acknowledgement")));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "could not be submitted",
    );
    expect(screen.getByRole("button", { name: "Accept" })).not.toBeDisabled();
  });
  it("fences late user-file responses across a changed owned request", async () => {
    let finish!: (uris: string[]) => void;
    const chooseResources = vi.fn(
      (_options, _signal: AbortSignal) =>
        new Promise<string[]>((done) => {
          finish = done;
        }),
    );
    const raw = {
      type: "object",
      properties: {
        files: {
          type: "array",
          items: { type: "string", format: "uri" },
          "x-openai-input": {
            type: "resource",
            options: [],
            selection: "implicit",
          },
        },
      },
    };
    const plan = compilePluginForm(raw, { ...profile, userResources: true });
    const changed = vi.fn();
    const props = {
      plan,
      ports: { chooseResources },
      values: initialPluginFormValues(plan),
      errors: {},
      onChange: changed,
    };
    const view = render(<PluginFormFields {...props} requestId="one" />);
    fireEvent.click(screen.getByRole("button", { name: "Choose files" }));
    await waitFor(() => expect(chooseResources).toHaveBeenCalledTimes(1));
    view.rerender(<PluginFormFields {...props} requestId="two" />);
    expect(chooseResources.mock.calls[0][1].aborted).toBe(true);
    await act(async () => finish(["fixture://late"]));
    expect(changed).not.toHaveBeenCalled();
  });
  it("releases late nested previews and active previews on revocation", async () => {
    let finish!: (value: { content: string; release: () => void }) => void;
    const preview = vi.fn(
      (_target, _signal: AbortSignal) =>
        new Promise<{ content: string; release: () => void }>((done) => {
          finish = done;
        }),
    );
    const raw = {
      type: "object",
      properties: {
        file: {
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
    };
    const plan = compilePluginForm(raw, { ...profile, previews: true }),
      ports: PluginFormPorts = { preview };
    const props = {
      requestId: "one",
      plan,
      ports,
      values: initialPluginFormValues(plan),
      errors: {},
      onChange: vi.fn(),
    };
    const view = render(<PluginFormFields {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Preview One" }));
    await waitFor(() => expect(preview).toHaveBeenCalledTimes(1));
    view.rerender(<PluginFormFields {...props} disabled />);
    const release = vi.fn();
    await act(async () => finish({ content: "late", release }));
    expect(release).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("late")).toBeNull();
    view.rerender(<PluginFormFields {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Preview One" }));
    await waitFor(() => expect(preview).toHaveBeenCalledTimes(2));
    const activeRelease = vi.fn(() => {
      throw new Error("Synthetic cleanup failure");
    });
    await act(async () =>
      finish({ content: "nested content", release: activeRelease }),
    );
    expect(screen.getByText("nested content")).toBeInTheDocument();
    view.rerender(<PluginFormFields {...props} disabled />);
    expect(activeRelease).toHaveBeenCalledTimes(1);
  });
  it("shows the host's description when a preview can't open, and stays answerable", async () => {
    const preview = vi
      .fn()
      .mockRejectedValueOnce(
        new PluginDescribedError(
          "The preview didn't open within 30 seconds.",
          "PLUGIN_FORM_PREVIEW_TIMEOUT",
        ),
      )
      .mockRejectedValueOnce(new Error("internal detail"));
    const raw = {
      type: "object",
      properties: {
        file: {
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
                    target: { type: "mcp_app_tool", name: "one.preview" },
                  },
                },
              },
            ],
          },
        },
      },
    };
    const plan = compilePluginForm(raw, { ...profile, previews: true });
    const onChange = vi.fn();
    render(
      <PluginFormFields
        requestId="one"
        plan={plan}
        ports={{ preview }}
        values={{ file: "fixture://one" }}
        errors={{}}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Preview One" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The preview didn't open within 30 seconds.",
    );
    expect(screen.queryByText("Waiting for the host…")).toBeNull();
    expect(screen.getByRole("radio", { name: "One" })).toBeEnabled();
    expect(screen.getByRole("radio", { name: "One" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    // Anything else stays generic: no internal detail reaches the form.
    fireEvent.click(screen.getByRole("button", { name: "Preview One" }));
    expect(
      await screen.findByText(
        "The host could not complete this request. Try again.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("internal detail")).toBeNull();
    expect(preview).toHaveBeenCalledTimes(2);
    expect(preview.mock.calls[0][0]).toEqual({
      type: "mcp_app_tool",
      name: "one.preview",
    });
    expect(onChange).not.toHaveBeenCalled();
  });
});
