import { act, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ComparePaneSkills } from "../compare-pane-skills";
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
      within(b).getByText("This client can’t use skills from MCP servers."),
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
