import { StrictMode } from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ fetch: vi.fn(), log: vi.fn() }));
vi.mock("@/lib/session-token", () => ({ authFetch: state.fetch }));
vi.mock("@/lib/plugin-extension-logs", () => ({
  logPluginExtensionIssue: state.log,
}));
import {
  PLUGIN_FORM_DESTINATION_TIMEOUT_MS,
  PluginFormFileServices,
  formFileUploadPorts,
} from "../form-files";
import { describePluginError } from "@/shared/plugin-diagnostics";
const schema = {
  type: "object",
  properties: {
    files: {
      type: "array",
      items: { type: "string", format: "uri" },
      "x-openai-input": {
        type: "resource",
        selection: "implicit",
        options: [],
      },
    },
  },
};
const base = {
  scope: { projectId: "project", workspaceId: "workspace" },
  sourceToken: "a".repeat(43),
  parent: { kind: "legacy" as const, id: "parent", round: 0 as const },
  expiresAt: Date.now() + 60000,
  schema,
};
const children = ({ ports, userResources }: any) => (
  <p>{`ready:${userResources}:${!!ports.chooseResources}`}</p>
);
beforeEach(() => {
  state.fetch.mockReset();
  state.log.mockReset();
});
describe("actual file service admission before owned editor mount", () => {
  it("passes the actual admitted directory kinds to the editor", async () => {
    state.fetch.mockImplementation(async () =>
      Response.json({
        userResources: true,
        userResourceKinds: ["file", "directory"],
      }),
    );
    render(
      <PluginFormFileServices {...base}>
        {({ userResourceKinds }) => <p>{userResourceKinds.join(",")}</p>}
      </PluginFormFileServices>,
    );
    await screen.findByText("file,directory");
  });
  it("uses directory input metadata, sends one hierarchy and retains one opaque retry receipt", async () => {
    const ports = formFileUploadPorts(
      base.scope,
      base.sourceToken,
      base.parent,
    );
    const files = [
      new File(["π\0"], "one.txt", { type: "text/plain" }),
      new File(["other"], "one.txt", { type: "text/plain" }),
    ];
    files.forEach((file, index) =>
      Object.defineProperty(file, "webkitRelativePath", {
        value: `selected/${index}/one.txt`,
      }),
    );
    // jsdom lacks Blob.arrayBuffer; exercise its actual FileReader bytes rather than a fake digest.
    files.forEach((file) =>
      Object.defineProperty(file, "arrayBuffer", {
        value: () =>
          new Promise<ArrayBuffer>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as ArrayBuffer);
            reader.onerror = () => reject(reader.error);
            reader.readAsArrayBuffer(file);
          }),
      }),
    );
    state.fetch.mockImplementation(async () =>
      Response.json({
        uris: ["mcpjam-form-file://00000000-0000-4000-8000-000000000000"],
      }),
    );
    const click = vi
      .spyOn(HTMLInputElement.prototype, "click")
      .mockImplementation(function (this: HTMLInputElement) {
        expect(this.webkitdirectory).toBe(true);
        Object.defineProperty(this, "files", { value: files });
        this.dispatchEvent(new Event("change"));
      });
    try {
      const context = { field: "directory", multiple: false };
      const first = await ports.chooseResources!(
        { kind: "directory" },
        new AbortController().signal,
        context,
      );
      expect(
        await ports.chooseResources!(
          { kind: "directory" },
          new AbortController().signal,
          context,
        ),
      ).toEqual(first);
      const bodies = state.fetch.mock.calls.map((call) =>
        JSON.parse(call[1].body.get("request")),
      );
      expect(bodies[0].relativePaths).toEqual([
        "selected/0/one.txt",
        "selected/1/one.txt",
      ]);
      expect(bodies[1].operationId).toBe(bodies[0].operationId);
      expect(ports.resourceLabel!(first[0]!)).toBe("selected");
      expect(document.querySelector('input[type="file"]')).toBeNull();
    } finally {
      click.mockRestore();
    }
  });
  it("says why an upload was refused and writes the Logs entry", async () => {
    const ports = formFileUploadPorts(
      base.scope,
      base.sourceToken,
      base.parent,
    );
    const file = new File(["one"], "one.txt", { type: "text/plain" });
    Object.defineProperty(file, "arrayBuffer", {
      value: async () => new TextEncoder().encode("one").buffer,
    });
    state.fetch.mockResolvedValue(
      Response.json(
        {
          code: "PLUGIN_FORMS_DISABLED",
          description: "This client has Forms turned off.",
          diagnostics: [
            {
              level: "warning",
              code: "PLUGIN_FORMS_DISABLED",
              title: "Upload refused: Forms is turned off for this client",
              description: "This client has Forms turned off.",
              serverId: "server",
            },
          ],
        },
        { status: 403 },
      ),
    );
    const click = vi
      .spyOn(HTMLInputElement.prototype, "click")
      .mockImplementation(function (this: HTMLInputElement) {
        Object.defineProperty(this, "files", { value: [file] });
        this.dispatchEvent(new Event("change"));
      });
    try {
      await expect(
        ports.chooseResources!({ kind: "file" }, new AbortController().signal, {
          field: "file",
          multiple: false,
        }),
      ).rejects.toThrow("This client has Forms turned off.");
      expect(state.log).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          code: "PLUGIN_FORMS_DISABLED",
          level: "warning",
          serverId: "server",
          message: "This client has Forms turned off.",
        }),
      );
    } finally {
      click.mockRestore();
    }
  });
  it("waits for the target service under StrictMode and installs the actual chooser only after admission", async () => {
    state.fetch.mockImplementation(async () =>
      Response.json({ userResources: true, userResourceKinds: ["file"] }),
    );
    render(
      <StrictMode>
        <PluginFormFileServices {...base}>{children}</PluginFormFileServices>
      </StrictMode>,
    );
    expect(screen.queryByText(/ready:/)).not.toBeInTheDocument();
    await screen.findByText("ready:true:true");
    expect(state.fetch).toHaveBeenCalledTimes(2);
    const body = JSON.parse(state.fetch.mock.calls[1][1].body);
    expect(body).toEqual({
      projectId: "project",
      pluginWorkspace: { version: 1, workspaceId: "workspace" },
      sourceToken: base.sourceToken,
      parent: base.parent,
    });
  });
  it("does not carry an admitted upload port into the next input key before its fresh admission finishes", async () => {
    let finish!: (reply: Response) => void;
    state.fetch
      .mockResolvedValueOnce(
        Response.json({ userResources: true, userResourceKinds: ["file"] }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
    const parent = {
      kind: "mrtr" as const,
      id: "parent",
      round: 1,
      inputRequestKey: "first",
    };
    const view = render(
      <PluginFormFileServices {...base} parent={parent}>
        {children}
      </PluginFormFileServices>,
    );
    await screen.findByText("ready:true:true");
    view.rerender(
      <PluginFormFileServices
        {...base}
        sourceToken={"b".repeat(43)}
        parent={{ ...parent, inputRequestKey: "second" }}
      >
        {children}
      </PluginFormFileServices>,
    );
    expect(screen.queryByText(/ready:/)).not.toBeInTheDocument();
    expect(
      screen.getByText("Checking the file destination."),
    ).toBeInTheDocument();
    finish(Response.json({ userResources: false, userResourceKinds: [] }));
    await screen.findByText("ready:false:false");
  });
  it("retries unavailable admission without mounting a schema-less Accept and permits cancellation", async () => {
    state.fetch
      .mockRejectedValueOnce(new Error("lost read"))
      .mockResolvedValueOnce(
        Response.json({ userResources: false, userResourceKinds: [] }),
      );
    const cancel = vi.fn().mockResolvedValue(undefined);
    render(
      <PluginFormFileServices {...base} onCancel={cancel}>
        {children}
      </PluginFormFileServices>,
    );
    await screen.findByText("File target unavailable");
    expect(screen.queryByText(/ready:/)).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Cancel", exact: true }),
    );
    await waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "Retry", exact: true }));
    await screen.findByText("ready:false:false");
  });
  it("fences an admission result after unmount", async () => {
    let complete!: (value: Response) => void;
    state.fetch.mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const view = render(
      <PluginFormFileServices {...base}>{children}</PluginFormFileServices>,
    );
    const signal = state.fetch.mock.calls[0][1].signal;
    view.unmount();
    expect(signal.aborted).toBe(true);
    complete(
      Response.json({ userResources: true, userResourceKinds: ["file"] }),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(screen.queryByText(/ready:/)).not.toBeInTheDocument();
  });
  it("waits for actual MRTR target admission with the exact round and input key", async () => {
    state.fetch.mockImplementation(async () =>
      Response.json({ userResources: true, userResourceKinds: ["file"] }),
    );
    const parent = {
      kind: "mrtr" as const,
      id: "parent",
      round: 2,
      inputRequestKey: "key",
    };
    render(
      <PluginFormFileServices {...base} parent={parent}>
        {children}
      </PluginFormFileServices>,
    );
    expect(screen.queryByText(/ready:/)).not.toBeInTheDocument();
    await screen.findByText("ready:true:true");
    expect(JSON.parse(state.fetch.mock.calls[0][1].body).parent).toEqual(
      parent,
    );
  });
  it.each(["ordinary", "no-source"])(
    "withholds the unconnected %s upload port without a synthetic chooser",
    (kind) => {
      render(
        <PluginFormFileServices
          {...base}
          {...(kind === "ordinary"
            ? { schema: { type: "object", properties: {} } }
            : { sourceToken: undefined })}
        >
          {children}
        </PluginFormFileServices>,
      );
      expect(screen.getByText("ready:false:false")).toBeInTheDocument();
      expect(state.fetch).not.toHaveBeenCalled();
    },
  );
});

describe("a destination check that doesn't finish", () => {
  // Never settles on its own; only its signal ends it.
  const hang = (_url: string, init: { signal: AbortSignal }) =>
    new Promise<Response>((_resolve, reject) =>
      init.signal.addEventListener("abort", () => reject(init.signal.reason), {
        once: true,
      }),
    );
  const server = { serverId: "server-1", serverName: "Local uploads" };

  it("ends after 30 seconds with a described error and a Logs entry, and Retry checks again", async () => {
    vi.useFakeTimers();
    try {
      state.fetch
        .mockImplementationOnce(hang)
        .mockResolvedValueOnce(
          Response.json({ userResources: true, userResourceKinds: ["file"] }),
        );
      render(
        <PluginFormFileServices
          {...base}
          expiresAt={Date.now() + 5 * 60_000}
          server={server}
        >
          {children}
        </PluginFormFileServices>,
      );
      expect(
        screen.getByText("Checking the file destination."),
      ).toBeInTheDocument();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(
          PLUGIN_FORM_DESTINATION_TIMEOUT_MS - 1,
        );
      });
      expect(
        screen.getByText("Checking the file destination."),
      ).toBeInTheDocument();
      expect(state.log).not.toHaveBeenCalled();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      const description = describePluginError(
        "PLUGIN_FORM_DESTINATION_TIMEOUT",
      )!;
      expect(screen.getByText("File target unavailable")).toBeInTheDocument();
      expect(screen.getByText(description)).toBeInTheDocument();
      expect(
        screen.queryByText("Checking the file destination."),
      ).not.toBeInTheDocument();
      expect(state.log).toHaveBeenCalledOnce();
      expect(state.log).toHaveBeenCalledWith(
        expect.objectContaining({
          code: "PLUGIN_FORM_DESTINATION_TIMEOUT",
          level: "error",
          message: description,
          serverId: "server-1",
          serverName: "Local uploads",
        }),
      );
      // The hung request was let go, not left running.
      expect(
        (state.fetch.mock.calls[0][1] as { signal: AbortSignal }).signal
          .aborted,
      ).toBe(true);
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Retry" }));
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(state.fetch).toHaveBeenCalledTimes(2);
      expect(screen.getByText("ready:true:true")).toBeInTheDocument();
      expect(state.log).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("ends when the form's own window closes first, instead of waiting forever", async () => {
    vi.useFakeTimers();
    try {
      state.fetch.mockImplementation(hang);
      render(
        <PluginFormFileServices {...base} expiresAt={Date.now() + 5_000}>
          {children}
        </PluginFormFileServices>,
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(screen.getByText("File target unavailable")).toBeInTheDocument();
      expect(
        screen.getByText(describePluginError("FORM_SOURCE_UNAVAILABLE")!),
      ).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows the server's own description for a refused check and logs it once", async () => {
    state.fetch.mockResolvedValueOnce(
      Response.json(
        {
          code: "PLUGIN_FORMS_DISABLED",
          description: "Forms is turned off for this client.",
          diagnostics: [
            {
              level: "warning",
              code: "PLUGIN_FORMS_DISABLED",
              title: "Upload refused",
              description: "Forms is turned off for this client.",
              serverId: "server-1",
            },
          ],
        },
        { status: 403 },
      ),
    );
    render(
      <PluginFormFileServices {...base} server={server}>
        {children}
      </PluginFormFileServices>,
    );
    await screen.findByText("Forms is turned off for this client.");
    expect(state.log).toHaveBeenCalledOnce();
    expect(state.log).toHaveBeenCalledWith(
      expect.objectContaining({ code: "PLUGIN_FORMS_DISABLED" }),
    );
  });

  it("logs nothing when the form closes mid-check", async () => {
    state.fetch.mockImplementation(hang);
    const view = render(
      <PluginFormFileServices {...base} server={server}>
        {children}
      </PluginFormFileServices>,
    );
    await waitFor(() => expect(state.fetch).toHaveBeenCalledOnce());
    view.unmount();
    await Promise.resolve();
    expect(state.log).not.toHaveBeenCalled();
  });
});
