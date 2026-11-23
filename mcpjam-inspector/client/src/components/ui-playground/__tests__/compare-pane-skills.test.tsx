import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ComparePaneSkills,
  useComparePaneSkillsSection,
} from "../compare-pane-skills";
import type { RecoveryPane } from "@/lib/comparison-recovery-record";

const { flag, fetchPreview } = vi.hoisted(() => ({
  flag: { value: undefined as boolean | undefined },
  fetchPreview: vi.fn<typeof fetch>(),
}));
vi.mock("posthog-js/react", () => ({
  useFeatureFlagEnabled: () => flag.value,
}));
vi.mock("@/lib/session-token", () => ({ authFetch: fetchPreview }));

const paneA: RecoveryPane = {
  paneId: "a",
  target: { kind: "environment", environmentId: "A" },
  serverIds: [],
};
const paneB: RecoveryPane = {
  paneId: "b",
  target: { kind: "environment", environmentId: "B" },
  serverIds: null,
  pluginVersionIds: [],
};
const client: RecoveryPane = {
  paneId: "c",
  target: { kind: "host", hostId: "same-client" },
};
const row = {
  skillId: "s1",
  name: "Find invoices",
  description: "Find invoices by order.",
  channels: ["environment"],
  reason: null,
};
const view = (pane: RecoveryPane, projectId: string | null = "proj") => (
  <ComparePaneSkills namedSetupsVisible pane={pane} projectId={projectId} />
);

describe("Compare pane Skills", () => {
  beforeEach(() => {
    flag.value = true;
    fetchPreview.mockReset();
  });
  it.each([false, undefined])(
    "does not render or fetch with flag %s",
    (value) => {
      flag.value = value;
      render(view(paneA));
      expect(screen.queryByRole("region")).toBeNull();
      expect(fetchPreview).not.toHaveBeenCalled();
    },
  );

  it("does not read a stored named target when named setups are hidden; client Skills still work", async () => {
    fetchPreview.mockResolvedValue(
      Response.json({ deliveredCount: 0, skills: [] }),
    );
    const ui = render(
      <ComparePaneSkills
        namedSetupsVisible={false}
        projectId="p"
        pane={paneA}
      />,
    );
    expect(screen.queryByRole("region")).toBeNull();
    expect(fetchPreview).not.toHaveBeenCalled();
    ui.rerender(
      <ComparePaneSkills
        namedSetupsVisible={false}
        projectId="p"
        pane={client}
      />,
    );
    expect(await screen.findByText("No skills for this pane.")).toBeVisible();
    expect(fetchPreview).toHaveBeenCalledOnce();
  });

  it("waits for a client’s plugin setup before requesting its effective skills", async () => {
    fetchPreview.mockResolvedValue(
      Response.json({ deliveredCount: 0, skills: [] }),
    );
    const ui = render(
      <ComparePaneSkills
        namedSetupsVisible
        projectId="proj"
        pane={client}
        pending
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Loading skills");
    expect(fetchPreview).not.toHaveBeenCalled();
    ui.rerender(
      <ComparePaneSkills
        namedSetupsVisible
        projectId="proj"
        pane={client}
        clientEnvironmentId="adhoc"
      />,
    );
    expect(await screen.findByText("No skills for this pane.")).toBeVisible();
    expect(fetchPreview).toHaveBeenCalledTimes(1);
    flag.value = false;
    ui.rerender(view(client));
    expect(screen.queryByRole("region")).toBeNull();
  });

  it("can retry a failed preview in place without changing the selected pane", async () => {
    fetchPreview
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(
        Response.json({ deliveredCount: 1, skills: [row] }),
      );
    render(view(paneA));
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    expect(await screen.findByText(row.name)).toBeVisible();
    expect(fetchPreview.mock.calls[0][1]?.body).toBe(
      fetchPreview.mock.calls[1][1]?.body,
    );
  });

  it("does not request a project pool without a signed-in project", () => {
    render(view(client, null));
    expect(screen.queryByRole("region")).toBeNull();
    expect(fetchPreview).not.toHaveBeenCalled();
  });

  it("keeps two setups' lists independent and counts only skills available on that pane", async () => {
    fetchPreview
      .mockResolvedValueOnce(
        Response.json({ deliveredCount: 1, skills: [row] }),
      )
      .mockResolvedValueOnce(
        Response.json({
          deliveredCount: 0,
          skills: [
            {
              ...row,
              reason: "server-skill-unsupported",
              channels: ["mcp-server"],
            },
          ],
        }),
      );
    render(
      <>
        {view(paneA)}
        {view(paneB)}
      </>,
    );
    const [a, b] = screen.getAllByRole("region", { name: "Skills" });
    expect(await within(a).findByText("1 skill available")).toBeVisible();
    expect(await within(b).findByText("0 skills available")).toBeVisible();
    expect(
      within(b).getByText(
        "Skills from MCP servers don’t load on this client yet.",
      ),
    ).toBeVisible();
    expect(within(a).getByText(row.description)).toBeVisible();
    const requests = fetchPreview.mock.calls.map(([, init]) =>
      JSON.parse(String(init?.body)),
    );
    expect(requests).toEqual([
      { projectId: "proj", target: paneA.target, serverIds: [] },
      { projectId: "proj", target: paneB.target, pluginVersionIds: [] },
    ]);
  });

  it("says why the turn plan leaves each skill out, and marks one the model won't see listed", async () => {
    fetchPreview.mockResolvedValue(
      Response.json({
        deliveredCount: 1,
        skills: [
          { ...row, omittedFromCatalog: true },
          {
            ...row,
            skillId: "s2",
            name: "search",
            channels: ["mcp-server"],
            reason: "server-skill-unsupported",
            origin: { kind: "mcp-server", server: "Linear" },
          },
          {
            ...row,
            skillId: "s3",
            name: "Draft replies",
            channels: ["project"],
            reason: "over-cap",
            origin: { kind: "library" },
          },
        ],
      }),
    );
    render(view(paneA));
    expect(await screen.findByText("1 skill available")).toBeVisible();
    expect(
      screen.getByText(
        "Not in the model’s skill list. Ask for it by name to use it.",
      ),
    ).toBeVisible();
    expect(
      screen.getByText("Skills from Linear don’t load on this client yet."),
    ).toBeVisible();
    expect(
      screen.getByText("Over the skill limit, so it doesn’t load."),
    ).toBeVisible();
    expect(screen.queryByText(row.description)).toBeNull();
  });

  it("sizes the skill list for the model each pane runs", async () => {
    fetchPreview.mockImplementation(async () =>
      Response.json({ deliveredCount: 0, skills: [] }),
    );
    const { result } = renderHook(() =>
      useComparePaneSkillsSection("proj", true),
    );
    const lane = { environmentId: null, pending: false };
    const model = { id: "m", name: "M", provider: "openai" };
    render(
      <>
        {result.current({
          pane: paneA,
          lane,
          model: { ...model, contextLength: 200_000 },
        })}
        {result.current({ pane: paneB, lane, model })}
      </>,
    );
    expect(await screen.findAllByText("No skills for this pane.")).toHaveLength(
      2,
    );
    const [sized, unsized] = fetchPreview.mock.calls.map(([, init]) =>
      JSON.parse(String(init?.body)),
    );
    expect(sized).toMatchObject({ modelContextTokens: 200_000 });
    // A turn on a model that states no size uses the default list size.
    expect(unsized).not.toHaveProperty("modelContextTokens");
  });

  it("never shows a late response for a previous target and reads a client's composed setup", async () => {
    const previous = Promise.withResolvers<Response>();
    fetchPreview
      .mockReturnValueOnce(previous.promise)
      .mockResolvedValueOnce(Response.json({ deliveredCount: 0, skills: [] }));
    const ui = render(view(paneA));
    ui.rerender(
      <ComparePaneSkills
        namedSetupsVisible
        pane={client}
        projectId="proj"
        clientEnvironmentId="adhoc"
      />,
    );
    expect(await screen.findByText("No skills for this pane.")).toBeVisible();
    await act(async () =>
      previous.resolve(Response.json({ deliveredCount: 1, skills: [row] })),
    );
    expect(screen.queryByText(row.name)).toBeNull();
    expect(
      JSON.parse(String(fetchPreview.mock.calls[1][1]?.body)),
    ).toMatchObject({
      target: { kind: "client", hostId: "same-client", environmentId: "adhoc" },
    });
  });
});
