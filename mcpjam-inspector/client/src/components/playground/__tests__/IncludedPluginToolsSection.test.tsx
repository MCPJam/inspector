import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { IncludedPluginToolsSection } from "../IncludedPluginToolsSection";

const f = vi.hoisted(() => ({
  target: null as {
    ownerKey: string;
    projectId: string;
    environmentId: string;
    serverIds: string[];
    includeAppOnly?: boolean;
  } | null,
  fetch: vi.fn(),
}));
vi.mock("@/lib/session-token", () => ({ authFetch: f.fetch }));
vi.mock("@/hooks/useProjects", () => ({ shouldQueryProjectId: () => true }));
vi.mock("@/components/host-workspace/ExtensionWorkspaceProvider", () => ({
  useExtensionWorkspaceState: (select: (state: unknown) => unknown) =>
    select({ includedPluginTools: f.target }),
}));
vi.mock("@/components/ui/schema-viewer", () => ({
  SchemaViewer: () => <span>Input schema</span>,
}));
const server = (name: string, serverId = "plugin") => ({
  serverId,
  name,
  source: "plugin",
  tools: [
    {
      name: "cad.library",
      description: "Read the library",
      inputSchema: { type: "object" },
    },
    {
      name: "app.internal",
      inputSchema: { type: "object" },
      _meta: { ui: { visibility: ["app"] } },
    },
  ],
});
const response = (servers: ReturnType<typeof server>[]) =>
  Response.json({ servers });
beforeEach(() => {
  vi.clearAllMocks();
  f.target = {
    ownerKey: "owner-a",
    projectId: "project",
    environmentId: "environment",
    serverIds: ["plugin"],
  };
});
afterEach(cleanup);

it("shows exact contributed sources and model-visible tools without a direct Run", async () => {
  f.fetch.mockResolvedValue(
    response([server("Bits & Bolts"), server("Not included", "other")]),
  );
  render(<IncludedPluginToolsSection />);
  expect(await screen.findByText("Bits & Bolts")).toBeTruthy();
  expect(screen.getByText("cad.library")).toBeTruthy();
  expect(screen.queryByText("app.internal")).toBeNull();
  expect(screen.queryByText("Not included")).toBeNull();
  expect(screen.queryByRole("button", { name: /^Run/ })).toBeNull();
  expect(f.fetch).toHaveBeenCalledWith(
    "/api/web/environments/environment/tools?projectId=project",
  );
});
it("matches the saved visibility override and handles an empty catalog", async () => {
  f.target = { ...f.target!, includeAppOnly: true };
  f.fetch
    .mockResolvedValueOnce(response([server("Bits")]))
    .mockResolvedValueOnce(response([]));
  const view = render(<IncludedPluginToolsSection />);
  expect(await screen.findByText("app.internal")).toBeTruthy();
  f.target = { ...f.target!, environmentId: "empty" };
  view.rerender(<IncludedPluginToolsSection />);
  expect(
    await screen.findByText("No plugin tools are available for this chat."),
  ).toBeTruthy();
});
it("blanks the previous host while its new catalog is pending and hides everything on access loss", async () => {
  let finish: (value: Response) => void = () => {};
  f.fetch
    .mockResolvedValueOnce(response([server("Previous host")]))
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
  const view = render(<IncludedPluginToolsSection />);
  expect(await screen.findByText("Previous host")).toBeTruthy();
  f.target = { ...f.target!, environmentId: "new-host" };
  view.rerender(<IncludedPluginToolsSection />);
  expect(screen.queryByText("Previous host")).toBeNull();
  await waitFor(() => expect(f.fetch).toHaveBeenCalledTimes(2));
  f.target = null;
  view.rerender(<IncludedPluginToolsSection />);
  await act(async () => {
    finish(response([server("Late host")]));
  });
  expect(
    screen.queryByRole("region", { name: "Plugin tools in this chat" }),
  ).toBeNull();
  expect(screen.queryByText("Late host")).toBeNull();
});
it("reports an authorization failure without retaining a catalog", async () => {
  f.fetch.mockResolvedValue(
    new Response(JSON.stringify({ error: "No access" }), { status: 403 }),
  );
  render(<IncludedPluginToolsSection />);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Couldn't load plugin tools. Try Refresh.",
  );
  expect(screen.queryByText("cad.library")).toBeNull();
});
