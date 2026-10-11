import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * OpenAI MCP Extensions, "OpenAI Form Elicitation" through "Previews", on the
 * wires: capability advertisement, the legacy `openai/elicitation/create`
 * request and the 2026-07-28 MRTR round, and previews on the originating
 * server. Schema rules live in shared/__tests__; the card in the client.
 */
const seams = vi.hoisted(() => ({
  callback: vi.fn(),
  resume: vi.fn(),
  cancel: vi.fn(),
  query: vi.fn(),
}));
vi.mock("../../../routes/web/hosted-elicitation.js", () => ({
  HostedElicitationBridge: class {
    callback = seams.callback;
    dispose = vi.fn();
    attachStreamWriter() {}
  },
}));
vi.mock("../../../utils/mrtr-hosted-collector.js", async (original) => ({
  ...(await original<
    typeof import("../../../utils/mrtr-hosted-collector.js")
  >()),
  resumeMrtrContinuationLeg: seams.resume,
}));
vi.mock("../../../utils/mrtr-continuation-state.js", async (original) => ({
  ...(await original<
    typeof import("../../../utils/mrtr-continuation-state.js")
  >()),
  cancelContinuation: seams.cancel,
}));
vi.mock("../../evals/route-helpers.js", () => ({
  createConvexClient: () => ({ query: seams.query }),
}));
import {
  applyPluginExtensionsToClientCapabilities,
  resolvePluginExtensions,
} from "@mcpjam/sdk/host-config/internal";
import {
  createOwnedPluginLegacyForms,
  installedFormClientCapabilities,
} from "../owned-legacy.js";
import { createOwnedPluginMrtr } from "../owned-mrtr.js";
import { pluginFormSources } from "../form-sources.js";
import { pluginInstances } from "../instances.js";
import { openPluginFormAppPreview } from "../form-app-preview.js";
import { readAuthorizedPluginFormResource } from "../form-resource-preview.js";
import type { ResolvedInvocationContext } from "../invocation.js";

/** An OpenAI form using the extended inputs, sent as-is on both wires. */
const extendedForm = {
  type: "object",
  required: ["part"],
  properties: {
    part: {
      type: "string",
      title: "Part",
      "x-openai-suggestions": [
        {
          const: "hex-bolt",
          title: "M6 hex bolt",
          description: "A fastener for the main joint.",
        },
      ],
    },
    accessories: {
      type: "array",
      items: {
        type: "string",
        "x-openai-suggestions": [{ const: "washer", title: "M6 washer" }],
      },
    },
  },
};
const unsupportedForm = {
  type: "object",
  properties: {
    part: { type: "string" },
    span: { type: "string", "x-openai-input": { type: "date-range" } },
  },
};
const accepted = {
  action: "accept",
  content: {
    part: "hex-bolt",
    accessories: ["washer", "custom-spacer", "custom-gasket"],
  },
};

describe("1. Capability Advertisement", () => {
  const codexCapture = {
    elicitation: { form: {} },
    extensions: { "openai/elicitation": { form: {} }, "openai/form": {} },
  };
  const toggles = (forms: boolean) =>
    resolvePluginExtensions({
      hostStyle: "codex",
      mcpProfile: {
        apps: { pluginExtensions: { enabled: true, capabilities: { forms } } },
      },
    });

  it('legacy initialize claims extensions["openai/elicitation"].form with forms on', () => {
    const on = toggles(true);
    expect(
      installedFormClientCapabilities(
        applyPluginExtensionsToClientCapabilities({}, on),
        { legacy: { binding: {} }, mrtr: false },
        on.capabilities.forms,
      ),
    ).toEqual({ extensions: { "openai/elicitation": { form: {} } } });
  });

  it("claims nothing with forms off, even from a client capture that does", () => {
    const off = toggles(false);
    expect(
      installedFormClientCapabilities(
        applyPluginExtensionsToClientCapabilities(codexCapture, off),
        { mrtr: false },
        off.capabilities.forms,
      ),
    ).toEqual({ elicitation: { form: {} } });
  });

  it("MRTR advertises standard form-mode elicitation", () => {
    const on = toggles(true);
    expect(
      installedFormClientCapabilities(
        { elicitation: { form: {} } },
        { mrtr: true },
        on.capabilities.forms,
      ),
    ).toMatchObject({ elicitation: { form: {} } });
  });
});

const legacyForms = () => {
  const forms = createOwnedPluginLegacyForms({
    bearer: "fixture",
    projectId: "project",
    workspaceId: "workspace",
    hostId: "host",
    hostRevision: "revision",
    serverId: "server",
    signal: new AbortController().signal,
    manager: () =>
      ({
        getInitializationInfo: () => ({ protocolVersion: "2025-11-25" }),
      }) as never,
    assertCurrent: async () => {},
    profile: {
      fileResources: true,
      origin: "server",
      userResources: false,
      previews: false,
    },
  });
  /** What the MCP client does: parse the envelope, then call the handler. */
  const request = async (params: unknown) => {
    const parsed =
      await forms.binding.schemas.params["~standard"].validate(params);
    if ("issues" in parsed && parsed.issues) throw new Error("InvalidParams");
    return forms.run(
      { origin: "model" } as ResolvedInvocationContext,
      "operation",
      new AbortController().signal,
      () => forms.binding.handler({ params: parsed.value as never }),
    );
  };
  return { forms, request };
};

describe("2. openai/elicitation/create is a drop-in superset of elicitation/create", () => {
  beforeEach(() => seams.callback.mockReset());
  it.each([[accepted], [{ action: "decline" }], [{ action: "cancel" }]])(
    "answers %j with the elicitation/create result shape",
    async (answer) => {
      seams.callback.mockResolvedValueOnce(answer);
      await expect(
        legacyForms().request({
          mode: "form",
          message: "Choose a CAD part to inspect",
          requestedSchema: extendedForm,
        }),
      ).resolves.toEqual(answer);
      // The schema reaches the user exactly as the server sent it.
      expect(seams.callback).toHaveBeenCalledWith(
        expect.objectContaining({ schema: extendedForm }),
      );
    },
  );
});

describe("3. Forms containing unsupported input types are reported as unsupported", () => {
  beforeEach(() => seams.callback.mockReset());
  it("legacy: delivers the whole form unchanged; the server gets the user's decline or cancel, never a partial accept", async () => {
    seams.callback.mockResolvedValueOnce({ action: "cancel" });
    const { request } = legacyForms();
    const params = { message: "Choose", requestedSchema: unsupportedForm };
    await expect(request(params)).resolves.toEqual({ action: "cancel" });
    expect(seams.callback).toHaveBeenCalledWith(
      expect.objectContaining({ schema: unsupportedForm }),
    );
    seams.callback.mockResolvedValueOnce({
      action: "accept",
      content: { part: "hex-bolt" },
    });
    await expect(request(params)).rejects.toThrow("does not satisfy");
  });
});

describe("10. Legacy and MRTR complete the same way", () => {
  const owner = {
    actorId: "actor",
    projectId: "project",
    workspaceId: "workspace",
    instanceId: "instance",
    generation: 1,
    serverId: "server",
    bindingId: "binding",
    placement: "interactive" as const,
  };
  const authorization: ResolvedInvocationContext = {
    owner,
    origin: "model",
    revision: "revision",
    tool: { name: "tool" },
    enabled: true,
    requiresApproval: false,
    allowedOrigins: ["model"],
  };
  const mrtr = () =>
    createOwnedPluginMrtr({
      c: {} as never,
      bearer: "fixture",
      projectId: "project",
      serverId: "server",
      sourceBinding: { hostId: "host", hostRevision: "host-revision" },
      assertCurrent: async () => {},
      manager: () =>
        ({
          getManagedClient: () => ({}),
          getInitializationInfo: () => ({ protocolVersion: "2026-07-28" }),
          getServerConfig: () => ({ url: "https://fixture.invalid" }),
        }) as never,
    });
  /** One MRTR round carrying `schema`; resolves with what reached the wire. */
  const mrtrRound = async (schema: unknown, response: unknown) => {
    pluginFormSources.bind({
      owner,
      hostId: "host",
      hostRevision: "host-revision",
      invocationId: "operation",
      origin: "model",
      revision: "revision",
      toolName: "tool",
      parent: {
        kind: "mrtr",
        id: "continuation",
        round: 1,
        inputRequestKey: "form",
      },
      requestedSchema: schema,
      expiresAt: Date.now() + 60_000,
    });
    let delivered: unknown;
    seams.resume.mockImplementationOnce(async (options) => {
      const prepared = await options.prepareLeg(
        {
          method: "tools/call",
          originalParams: { name: "tool" },
          pendingInputRequests: {
            form: {
              method: "elicitation/create",
              params: { mode: "form", message: "Choose", requestedSchema: schema },
            },
          },
        },
        { form: response },
      );
      prepared.commit();
      delivered = prepared.responses.form;
      return { outcome: "completed", result: { content: [] } };
    });
    await mrtr().resume(
      authorization,
      "operation",
      { name: "tool" },
      { continuationId: "continuation", round: 1, responsesBlobId: "r1" },
      new AbortController().signal,
    );
    return delivered;
  };
  const legacyRound = async (schema: unknown, response: unknown) => {
    seams.callback.mockResolvedValueOnce(response);
    return legacyForms().request({ message: "Choose", requestedSchema: schema });
  };
  beforeEach(() => seams.callback.mockReset());
  afterEach(() => {
    seams.resume.mockReset();
    pluginFormSources.closeOperation(owner, "operation");
  });

  it.each([[accepted], [{ action: "decline" }], [{ action: "cancel" }]])(
    "delivers %j identically on both wires",
    async (response) => {
      expect(await legacyRound(extendedForm, response)).toEqual(response);
      expect(await mrtrRound(extendedForm, response)).toEqual(response);
    },
  );

  it("refuses the same forged answer on both wires", async () => {
    const forged = { action: "accept", content: { part: 4 } };
    await expect(legacyRound(extendedForm, forged)).rejects.toThrow();
    await expect(mrtrRound(extendedForm, forged)).rejects.toThrow(
      "CONTINUATION_FORM_UNSUPPORTED",
    );
  });

  it("lets the user decline an unsupported form on both wires, and nothing more", async () => {
    expect(await legacyRound(unsupportedForm, { action: "decline" })).toEqual({
      action: "decline",
    });
    expect(await mrtrRound(unsupportedForm, { action: "decline" })).toEqual({
      action: "decline",
    });
    await expect(
      mrtrRound(unsupportedForm, { action: "accept", content: { part: "x" } }),
    ).rejects.toThrow();
  });

  it("reports MRTR expiry as a known outcome, like a legacy request that expired", async () => {
    seams.resume.mockResolvedValueOnce({
      outcome: "expired",
      reason: "continuation expired",
    });
    await expect(
      mrtr().resume(
        authorization,
        "operation",
        { name: "tool" },
        { continuationId: "continuation", round: 1, responsesBlobId: "r1" },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "CONTINUATION_EXPIRED" });
    seams.callback.mockRejectedValueOnce(new Error("Form request expired"));
    await expect(
      legacyForms().request({ message: "Choose", requestedSchema: extendedForm }),
    ).rejects.toThrow("expired");
  });
});

describe("9. Previews open on the originating server; arguments default to {}", () => {
  const cleanup: (() => unknown)[] = [];
  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((close) => close()));
  });
  async function preview(required: string[]) {
    const actor = {
      actorId: "actor",
      projectId: "project",
      workspaceId: crypto.randomUUID(),
      subject: "subject",
    };
    const port = {
      readActivation: async () => null,
      issueActivation: async (token: string, input: any) => ({
        token,
        control: {
          snapshotJson: input.snapshotJson,
          expiresAt: input.expiresAt,
        },
      }),
      close: async () => {},
    } as any;
    const opened = await pluginInstances.openActivationPersistent(
      actor,
      {
        runtime: "chatgpt",
        hostId: "host",
        hostRevision: "host-rev",
        serverId: "origin-server",
        bindingId: "binding",
        resourceUri: "ui://parent",
        serverIdentity: { kind: "standalone", serverId: "origin-server" },
        activation: {
          selector: { kind: "thread", threadId: "thread" },
          toolName: "source",
          revision: "source-rev",
        },
      },
      AbortSignal.timeout(1000),
      port,
    );
    const target = { type: "mcp_app_tool" as const, name: "cad.open" };
    const parent = {
      kind: "legacy" as const,
      id: crypto.randomUUID(),
      round: 0 as const,
    };
    const expiresAt = Date.now() + 60_000;
    const source = pluginFormSources.bind({
      owner: opened.instance.owner,
      hostId: "host",
      hostRevision: "host-rev",
      invocationId: "original",
      origin: "model",
      revision: "source-rev",
      toolName: "source",
      parent,
      expiresAt,
      requestedSchema: {
        type: "object",
        properties: {
          part: {
            type: "string",
            format: "uri",
            "x-openai-input": {
              type: "resource",
              options: [
                {
                  uri: "cad://parts/hex-bolt",
                  name: "hex-bolt",
                  _meta: { "openai/preview": { target } },
                },
              ],
            },
          },
        },
      },
    });
    cleanup.push(source.release, () =>
      pluginInstances.closePersistent(
        opened.token,
        actor,
        AbortSignal.timeout(1000),
        port,
      ),
    );
    seams.query.mockReset().mockResolvedValue({ actorId: "actor", expiresAt });
    const readResource = vi.fn(async (serverId: string) => {
      expect(serverId).toBe("origin-server");
      return {
        contents: [
          { uri: "ui://cad", mimeType: "text/html", text: "<p>CAD</p>" },
        ],
      };
    });
    const resolve = vi.fn(async (name: string) => ({
      tool: {
        name,
        inputSchema: { type: "object", properties: {}, required },
        _meta: { ui: { resourceUri: "ui://cad", visibility: ["app"] } },
      },
      revision: name === "source" ? "source-rev" : `${name}-rev`,
      hostRevision: "host-rev",
      bindingId: "binding",
      manager: {
        readResource,
        listResources: async () => ({ resources: [] }),
        getServerConfig: () => ({ url: "https://fixture.invalid/mcp" }),
      },
      appToolsEnabled: true,
    }));
    return openPluginFormAppPreview({
      actor,
      bearer: "private",
      sourceToken: source.token,
      parent,
      target,
      signal: AbortSignal.timeout(10_000),
      runtime: () =>
        ({
          resolve,
          resolveTools: async (names: string[]) =>
            new Map(
              await Promise.all(
                names.map(async (name) => [name, await resolve(name)] as const),
              ),
            ),
          release: async () => {},
        }) as any,
    });
  }

  it("opens the App tool on the server that asked for the form", async () => {
    await expect(preview([])).resolves.toMatchObject({
      serverId: "origin-server",
      toolName: "cad.open",
    });
  });

  it("a resource_link target reads the linked resource from that server", async () => {
    const readResource = vi.fn(async () => ({
      contents: [
        { uri: "cad://parts/hex-bolt", mimeType: "text/plain", text: "M6" },
      ],
    }));
    await expect(
      readAuthorizedPluginFormResource({
        serverId: "origin-server",
        target: {
          type: "resource_link",
          uri: "cad://parts/hex-bolt",
          name: "M6 hex bolt",
        },
        signal: new AbortController().signal,
        authorize: async () => ({ manager: { readResource } as never }),
      }),
    ).resolves.toEqual({
      type: "resource",
      contents: [
        { uri: "cad://parts/hex-bolt", mimeType: "text/plain", text: "M6" },
      ],
    });
    expect(readResource).toHaveBeenCalledWith(
      "origin-server",
      { uri: "cad://parts/hex-bolt" },
      expect.anything(),
    );
  });

  it("checks omitted arguments as {}", async () => {
    // A tool that requires an argument can't be previewed with none.
    await expect(preview(["file"])).rejects.toThrow();
  });
});
