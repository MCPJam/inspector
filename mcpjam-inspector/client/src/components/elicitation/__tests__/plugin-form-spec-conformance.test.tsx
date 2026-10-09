import { useLayoutEffect, useRef } from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * OpenAI MCP Extensions, "OpenAI Form Elicitation" through "Previews", as
 * the user sees it: the composer form card. One describe per rule, named
 * after the spec; schema rules live in shared/__tests__, wires in the
 * server's plugin-host tests.
 */
const convex = vi.hoisted(() => ({
  rows: [] as unknown[],
  mutate: vi.fn(),
  post: vi.fn(async (..._args: unknown[]) => ({
    ok: true,
    storageId: "receipt",
  })),
}));
vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true }),
  useConvex: () => ({ mutation: convex.mutate, action: vi.fn() }),
  useQuery: (name: string, args: unknown) =>
    name === "users:getCurrentUser"
      ? { _id: "owner" }
      : args === "skip"
        ? undefined
        : convex.rows,
}));
vi.mock("@/lib/apis/web/base", () => ({ webPost: convex.post }));
import { ComposerFormCard } from "../ComposerFormCard";
import { OwnedPluginFormHost } from "../OwnedPluginFormHost";
import {
  HostedMrtrHost,
  __resetHostedMrtrHostElection,
} from "../HostedMrtrHost";
import {
  __resetComposerFormStore,
  registerComposerSlot,
} from "../composer-form-store";
import {
  compileComposerForm,
  logComposerFormDiagnostics,
} from "../form-diagnostics";
import { useHostedMrtrStore } from "@/stores/hosted-mrtr-store";
import { useTrafficLogStore } from "@/stores/traffic-log-store";
import type { PluginFormPorts } from "../../schema-form/PluginFormFields";
import {
  compilePluginForm,
  type PluginFormProfile,
} from "@/shared/plugin-extensions/form-plan";

const profile: PluginFormProfile = {
  fileResources: true,
  origin: "server",
  userResources: true,
  userResourceKinds: ["file", "directory"],
  previews: true,
  previewKinds: ["resource_link", "mcp_app_tool"],
};

function card(
  schema: unknown,
  ports: PluginFormPorts = {},
  respond = vi.fn(async (..._args: unknown[]) => {}),
) {
  render(
    <ComposerFormCard
      requestId="conformance"
      title="Choose a CAD part to inspect"
      serverName="CAD Library"
      plan={compilePluginForm(schema, profile)}
      ports={ports}
      onRespond={respond}
    />,
  );
  return respond;
}
const next = () => fireEvent.click(screen.getByRole("button", { name: "Next" }));
const finish = () =>
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));

beforeEach(() => {
  __resetComposerFormStore();
  useTrafficLogStore.getState().clear();
});

describe("2. openai/elicitation/create is a superset of elicitation/create", () => {
  it("asks every MCP primitive, one step at a time, and accepts typed values", async () => {
    const respond = card({
      type: "object",
      required: ["email"],
      properties: {
        email: { type: "string", format: "email", title: "Email" },
        count: { type: "integer", minimum: 1, title: "Count" },
        rush: { type: "boolean", title: "Rush order" },
        size: { type: "string", enum: ["s", "m"], enumNames: ["Small", "Medium"] },
        finish: {
          type: "string",
          oneOf: [{ const: "matte", title: "Matte" }],
        },
        extras: {
          type: "array",
          items: { anyOf: [{ const: "nut", title: "Nut" }] },
        },
      },
    });
    const email = screen.getByLabelText(/Email/);
    expect(email).toHaveAttribute("type", "email");
    fireEvent.change(email, { target: { value: "a@b.co" } });
    next();
    fireEvent.change(screen.getByLabelText(/Count/), {
      target: { value: "3" },
    });
    next();
    fireEvent.click(screen.getByRole("checkbox", { name: /Rush order/ }));
    next();
    fireEvent.click(screen.getByRole("radio", { name: "Medium" }));
    next();
    fireEvent.click(screen.getByRole("radio", { name: "Matte" }));
    next();
    fireEvent.click(screen.getByRole("checkbox", { name: "Nut" }));
    finish();
    await waitFor(() =>
      expect(respond).toHaveBeenCalledWith("accept", {
        email: "a@b.co",
        count: 3,
        rush: true,
        size: "m",
        finish: "matte",
        extras: ["nut"],
      }),
    );
  });

  it.each([
    ["Decline", "decline"],
    ["Close", "cancel"],
  ])("%s answers %s without content", async (name, action) => {
    const respond = card({
      type: "object",
      properties: { note: { type: "string", title: "Note" } },
    });
    fireEvent.click(screen.getByRole("button", { name }));
    await waitFor(() => expect(respond).toHaveBeenCalledWith(action, undefined));
  });
});

describe("3. Forms containing unsupported input types are reported as unsupported, not partially displayed", () => {
  it("shows no field, names the field and reason, and writes one Logs entry", async () => {
    const compiled = compileComposerForm(
      {
        type: "object",
        properties: {
          part: { type: "string", title: "Part" },
          span: {
            type: "string",
            title: "Dates",
            "x-openai-input": { type: "date-range" },
          },
        },
      },
      profile,
    );
    logComposerFormDiagnostics(compiled, { serverId: "cad" });
    const respond = vi.fn(async () => {});
    render(
      <ComposerFormCard
        requestId="unsupported"
        title="Choose dates"
        serverName="CAD Library"
        unsupported={compiled.unsupported}
        onRespond={respond}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "This form can't be shown here.",
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Dates: It uses an input this client doesn't support.",
    );
    // Not even the supported field is shown.
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(
      useTrafficLogStore
        .getState()
        .mcpServerItems.filter((row) => row.serverId === "cad"),
    ).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Cancel request" }));
    await waitFor(() =>
      expect(respond).toHaveBeenCalledWith("cancel", undefined),
    );
  });
});

describe("4. Servers MAY add pattern to StringSchema", () => {
  const schema = {
    type: "object",
    required: ["part"],
    properties: {
      part: {
        type: "string",
        title: "Reference file",
        format: "uri",
        pattern: "^(cad|file):",
      },
      note: { type: "string", title: "Note", pattern: "^[a-z]+$" },
    },
  };
  it("blocks Next with a plain error", () => {
    const respond = card(schema);
    fireEvent.change(screen.getByLabelText(/Reference file/), {
      target: { value: "https://example.com/part" },
    });
    next();
    expect(screen.getByText("1 of 2")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "This answer isn't in the expected format.",
    );
    expect(screen.queryByText(/\^\(cad/)).toBeNull();
    expect(respond).not.toHaveBeenCalled();
  });
  it("blocks Continue with a plain error, then accepts a match", async () => {
    const respond = card(schema);
    fireEvent.change(screen.getByLabelText(/Reference file/), {
      target: { value: "cad://parts/hex-bolt" },
    });
    next();
    fireEvent.change(screen.getByLabelText(/Note/), {
      target: { value: "Not OK" },
    });
    finish();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "This answer isn't in the expected format.",
    );
    expect(respond).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText(/Note/), {
      target: { value: "ok" },
    });
    finish();
    await waitFor(() =>
      expect(respond).toHaveBeenCalledWith("accept", {
        part: "cad://parts/hex-bolt",
        note: "ok",
      }),
    );
  });
});

describe("5. Titled const options support an optional description", () => {
  it.each([
    ["a single select", { type: "string", oneOf: "OPTIONS" }],
    ["suggestions", { type: "string", "x-openai-suggestions": "OPTIONS" }],
  ])("shows the description in %s", (_, field) => {
    const options = [
      {
        const: "hex-bolt",
        title: "M6 hex bolt",
        description: "A fastener for the main joint.",
      },
    ];
    card({
      type: "object",
      properties: {
        part: JSON.parse(
          JSON.stringify(field).replace('"OPTIONS"', JSON.stringify(options)),
        ),
      },
    });
    expect(screen.getByText("A fastener for the main joint.")).toBeVisible();
  });
});

describe("6. Thumbnails: any option with one gives every option the image UI", () => {
  it("renders the image, and the fallback for options without a usable one", () => {
    card({
      type: "object",
      properties: {
        part: {
          type: "string",
          title: "Part",
          oneOf: [
            {
              const: "hex-bolt",
              title: "M6 hex bolt",
              "x-openai-thumbnail": { src: "https://example.com/hex-bolt.png" },
            },
            {
              const: "washer",
              title: "M6 washer",
              "x-openai-thumbnail": { src: "http://example.com/washer.png" },
            },
            { const: "nut", title: "M6 nut" },
          ],
        },
      },
    });
    const thumbnails = document.querySelectorAll('[data-thumbnail="row"]');
    expect(thumbnails).toHaveLength(3);
    expect([...thumbnails].map((cell) => !!cell.querySelector("img"))).toEqual(
      [true, false, false],
    );
  });
});

describe("7. Suggested values", () => {
  it("a string field takes a suggestion or the user's own text", async () => {
    const respond = card({
      type: "object",
      properties: {
        part: {
          type: "string",
          minLength: 1,
          title: "Part",
          "x-openai-suggestions": [{ const: "hex-bolt", title: "M6 hex bolt" }],
        },
      },
    });
    fireEvent.click(screen.getByRole("radio", { name: "M6 hex bolt" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Other Part" }), {
      target: { value: "custom-part" },
    });
    finish();
    await waitFor(() =>
      expect(respond).toHaveBeenCalledWith("accept", { part: "custom-part" }),
    );
  });

  it("an array picks several suggestions and adds custom entries, under the same constraints", async () => {
    const respond = card({
      type: "object",
      properties: {
        accessories: {
          type: "array",
          title: "Accessories",
          items: {
            type: "string",
            maxLength: 13,
            "x-openai-suggestions": [{ const: "washer", title: "M6 washer" }],
          },
        },
      },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "M6 washer" }));
    const add = (value: string) => {
      fireEvent.change(screen.getByLabelText("Add Accessories"), {
        target: { value },
      });
      fireEvent.click(screen.getByRole("button", { name: "Add" }));
    };
    add("custom-spacer");
    add("custom-gasket-too-long");
    finish();
    // An entered value breaks maxLength just as a suggestion would.
    expect(screen.getByRole("alert")).toHaveTextContent(
      "This answer doesn't fit what was asked.",
    );
    fireEvent.click(
      screen.getByRole("checkbox", { name: "custom-gasket-too-long" }),
    );
    add("custom-gasket");
    finish();
    await waitFor(() =>
      expect(respond).toHaveBeenCalledWith("accept", {
        accessories: ["washer", "custom-spacer", "custom-gasket"],
      }),
    );
  });
});

describe("8. Resource selection", () => {
  const options = [
    { uri: "cad://parts/hex-bolt", name: "hex-bolt", title: "M6 hex bolt" },
    { uri: "cad://parts/washer", name: "washer", title: "M6 washer" },
  ];
  it("a single-select field submits a URI string", async () => {
    const respond = card({
      type: "object",
      properties: {
        part: {
          type: "string",
          format: "uri",
          title: "Reference file",
          "x-openai-input": { type: "resource", options },
          default: "cad://parts/hex-bolt",
        },
      },
    });
    expect(screen.queryByRole("button", { name: /Choose/ })).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "M6 washer" }));
    finish();
    await waitFor(() =>
      expect(respond).toHaveBeenCalledWith("accept", {
        part: "cad://parts/washer",
      }),
    );
  });

  it("implicit selection submits what remains after removing and adding", async () => {
    const respond = card(
      {
        type: "object",
        properties: {
          parts: {
            type: "array",
            title: "Parts",
            items: { type: "string", format: "uri" },
            "x-openai-input": { type: "resource", selection: "implicit", options },
          },
        },
      },
      { chooseResources: async () => ["mcpjam-form-file://spacer"] },
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove M6 hex bolt" }));
    fireEvent.click(screen.getByRole("button", { name: "Choose files" }));
    await screen.findByRole("button", {
      name: "Remove mcpjam-form-file://spacer",
    });
    finish();
    await waitFor(() =>
      expect(respond).toHaveBeenCalledWith("accept", {
        parts: ["cad://parts/washer", "mcpjam-form-file://spacer"],
      }),
    );
  });
});

describe("9. Previews open expanded details without submitting or changing the form", () => {
  it("opens and closes a preview, leaving the selection and the request alone", async () => {
    const release = vi.fn();
    const preview = vi.fn(async () => ({
      content: <p>CAD preview</p>,
      release,
    }));
    const respond = card(
      {
        type: "object",
        properties: {
          part: {
            type: "string",
            format: "uri",
            title: "Reference file",
            "x-openai-input": {
              type: "resource",
              options: [
                {
                  uri: "cad://parts/hex-bolt",
                  name: "hex-bolt",
                  title: "M6 hex bolt",
                  _meta: {
                    "openai/preview": {
                      target: { type: "mcp_app_tool", name: "cad.open" },
                    },
                  },
                },
              ],
            },
          },
        },
      },
      { preview },
    );
    fireEvent.click(screen.getByRole("radio", { name: "M6 hex bolt" }));
    fireEvent.click(screen.getByRole("button", { name: "Preview M6 hex bolt" }));
    expect(await screen.findByText("CAD preview")).toBeInTheDocument();
    expect(preview.mock.calls[0]![0]).toEqual({
      type: "mcp_app_tool",
      name: "cad.open",
    });
    expect(respond).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Close preview" }));
    expect(release).toHaveBeenCalledOnce();
    expect(screen.getByRole("radio", { name: "M6 hex bolt" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    finish();
    await waitFor(() =>
      expect(respond).toHaveBeenCalledWith("accept", {
        part: "cad://parts/hex-bolt",
      }),
    );
  });
});

describe("10. Legacy and MRTR forms behave the same for the user", () => {
  const schema = {
    type: "object",
    properties: { note: { type: "string", title: "Note" } },
  };
  function Composer({ workspaceId }: { workspaceId: string }) {
    const slot = useRef<HTMLDivElement>(null);
    useLayoutEffect(
      () => registerComposerSlot(workspaceId, slot.current!),
      [workspaceId],
    );
    return <div ref={slot} data-testid="slot" />;
  }
  /** Mounts one pending form on a wire; returns what that wire received. */
  function mount(wire: "legacy" | "mrtr", workspaceId = "chat-a") {
    const submit = vi.fn(async (..._args: unknown[]) => {});
    const host = (shown: string) =>
      wire === "legacy" ? (
        <>
          <Composer workspaceId={shown} />
          <OwnedPluginFormHost projectId="project" workspaceId={shown} />
        </>
      ) : (
        <>
          <Composer workspaceId={shown} />
          <HostedMrtrHost />
        </>
      );
    if (wire === "legacy")
      convex.rows = [
        {
          rendezvousId: "legacy-1",
          serverId: "cad",
          serverName: "CAD Library",
          mode: "form",
          message: "Add a note",
          requestedSchema: schema,
          expiresAt: Date.now() + 60_000,
          formDialect: "openai",
          pluginWorkspaceId: workspaceId,
        },
      ];
    const view = render(host(workspaceId));
    if (wire === "mrtr")
      act(() =>
        useHostedMrtrStore.getState().enqueue(
          {
            key: "cont:1",
            continuationId: "cont",
            round: 1,
            serverId: "cad",
            serverName: "CAD Library",
            method: "tools/call",
            requests: [
              {
                key: "note",
                mode: "form" as const,
                message: "Add a note",
                requestedSchema: schema,
              },
            ],
            pluginFormProfile: {
              fileResources: true,
              origin: "server",
              userResources: false,
              previews: false,
            },
            pluginFormServiceScope: { projectId: "project", workspaceId },
            expiresAt: Date.now() + 60_000,
            timestamp: new Date().toISOString(),
          },
          { submit },
        ),
      );
    const received = () =>
      wire === "legacy"
        ? convex.mutate.mock.calls.map(([, answer]) => {
            // Legacy content travels privately; the answer names its receipt.
            const { action } = answer as { action: string };
            return action === "accept"
              ? { action, content: convex.post.mock.calls.at(-1)?.[1] }
              : { action };
          })
        : submit.mock.calls.map(([answers]) => ({
            ...(answers as Record<string, Record<string, unknown>>).note,
          }));
    return { view, host, received };
  }
  beforeEach(() => {
    convex.rows = [];
    convex.mutate.mockReset().mockResolvedValue({ ok: true });
    __resetHostedMrtrHostElection();
    useHostedMrtrStore.getState().__reset();
  });
  afterEach(() => {
    __resetHostedMrtrHostElection();
    useHostedMrtrStore.getState().__reset();
  });

  it.each(["legacy", "mrtr"] as const)(
    "%s: the card in the composer accepts the typed answer",
    async (wire) => {
      const { received } = mount(wire);
      const slot = screen.getByTestId("slot");
      await waitFor(() => expect(slot).toHaveTextContent("Add a note"));
      expect(screen.queryByRole("dialog")).toBeNull();
      fireEvent.change(screen.getByLabelText(/Note/), {
        target: { value: "same" },
      });
      finish();
      await waitFor(() =>
        expect(received()).toEqual([
          { action: "accept", content: { note: "same" } },
        ]),
      );
    },
  );

  it.each([
    ["legacy", "Decline", "decline"],
    ["legacy", "Close", "cancel"],
    ["mrtr", "Decline", "decline"],
    ["mrtr", "Close", "cancel"],
  ] as const)("%s: %s reaches the server as %s", async (wire, button, action) => {
    const { received } = mount(wire);
    await screen.findByLabelText(/Note/);
    fireEvent.click(screen.getByRole("button", { name: button }));
    await waitFor(() => expect(received()).toEqual([{ action }]));
  });

  it.each(["legacy", "mrtr"] as const)(
    "%s: a pending form keeps its answer across a chat switch",
    async (wire) => {
      const { view, host } = mount(wire);
      fireEvent.change(await screen.findByLabelText(/Note/), {
        target: { value: "half" },
      });
      view.rerender(host("chat-b"));
      await waitFor(() => expect(screen.queryByLabelText(/Note/)).toBeNull());
      view.rerender(host("chat-a"));
      expect(await screen.findByLabelText(/Note/)).toHaveValue("half");
    },
  );
});
