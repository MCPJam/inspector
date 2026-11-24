import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../climb-list", () => ({
  ClimbList: ({ onOpen, onStart }: { onOpen: (id: string) => void; onStart: () => void }) => (
    <div>
      <button onClick={() => onOpen("climb_9")}>open a climb</button>
      <button onClick={onStart}>start one</button>
    </div>
  ),
}));
vi.mock("../climb-screen", () => ({
  ClimbScreen: ({ climbId, labels, onBack }: { climbId: string; labels: Record<string, string>; onBack: () => void }) => (
    <div>
      climb {climbId} {Object.values(labels).join("|")}
      <button onClick={onBack}>back</button>
    </div>
  ),
}));
vi.mock("../start-form", () => ({
  StartForm: ({ servers, environments, onStarted, onCancel }: { servers: { name: string }[]; environments: { label: string }[]; onStarted: (c: { climbId: string }) => void; onCancel: () => void }) => (
    <div>
      form {servers.map((s) => s.name).join(",")} {environments.map((e) => e.label).join(",")}
      <button onClick={() => onStarted({ climbId: "climb_new" })}>started</button>
      <button onClick={onCancel}>cancel</button>
    </div>
  ),
}));
vi.mock("../use-mock-servers", () => ({ useMockServers: () => ({ mocks: new Map(), real: [{ id: "s1", name: "mcpjam-mcp" }], loading: false }) }));
vi.mock("@/hooks/use-available-models", () => ({ useAvailableModels: () => ({ availableModels: [{ id: "m1", name: "Sonnet" }] }) }));

import { SuiteClimbTab } from "../climb-tab";

const suite = { _id: "suite_1", name: "dogfood", environmentIds: ["env_a"] } as never;
const environments = [{ environmentId: "env_a", hostId: "host_1", modelId: "anthropic/sonnet-5.5", name: "Prod" }] as never;
const names = new Map([["host_1", "MCPJam"]]);

const show = (projectId: string | null = "proj_1") =>
  render(<SuiteClimbTab projectId={projectId} suite={suite} caseCount={10} environments={environments} hostNamesById={names} />);

describe("SuiteClimbTab", () => {
  it("lists climbs first, starts one with the project's real servers and the suite's environments, then opens it", async () => {
    show();
    await userEvent.click(screen.getByRole("button", { name: "start one" }));
    expect(screen.getByText(/form mcpjam-mcp MCPJam · /)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "started" }));
    expect(screen.getByText(/climb climb_new MCPJam · /)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "back" }));
    expect(screen.getByRole("button", { name: "open a climb" })).toBeInTheDocument();
  });
  it("opens a climb from the list, and goes back from the start form", async () => {
    show();
    await userEvent.click(screen.getByRole("button", { name: "open a climb" }));
    expect(screen.getByText(/climb climb_9/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "back" }));
    await userEvent.click(screen.getByRole("button", { name: "start one" }));
    await userEvent.click(screen.getByRole("button", { name: "cancel" }));
    expect(screen.getByRole("button", { name: "open a climb" })).toBeInTheDocument();
  });
  it("asks for a project when there is none", () => {
    show(null);
    expect(screen.getByText(/Open this suite from a project to climb it/)).toBeInTheDocument();
  });
});
