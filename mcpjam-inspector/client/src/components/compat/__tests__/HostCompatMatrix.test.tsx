import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { HostCompatReport } from "@/lib/host-compat/types";
import type { ServerWithName } from "@/state/app-types";

// Two-host registry keeps the rendered grid small and assertions tractable.
vi.mock("@/lib/host-compat/profiles", () => ({
  buildHostCompatProfiles: () => [
    { id: "claude", label: "Claude", logoSrc: "" },
    { id: "codex", label: "Codex", logoSrc: "" },
  ],
}));

// Canned per-server verdicts (defined inside the factory — vi.mock is hoisted).
vi.mock("@/lib/host-compat/use-host-compat", () => {
  const rep = (hostId: string, verdict: string) => ({
    hostId,
    hostLabel: hostId,
    logoSrc: "",
    verdict,
    provenance: "assumed",
    lanes: {
      apps: { verdict, provenance: "assumed" },
      server: { verdict: "works", provenance: "assumed" },
    },
    findings: [],
  });
  const REPORTS: Record<string, unknown[]> = {
    a: [rep("claude", "works"), rep("codex", "blocked")],
    b: [rep("claude", "works"), rep("codex", "degraded")],
  };
  return {
    useHostCompatReports: (server: { name: string }) => ({
      reports: REPORTS[server.name] ?? [],
      requirements: {},
    }),
  };
});

vi.mock("@/stores/preferences/preferences-provider", () => ({
  usePreferencesStore: (selector: (s: { themeMode: string }) => unknown) =>
    selector({ themeMode: "light" }),
}));

import { HostCompatMatrix, summarizeColumn } from "../HostCompatMatrix";

const rep = (hostId: string, verdict: HostCompatReport["verdict"]) =>
  ({ hostId, verdict }) as HostCompatReport;

const server = (name: string): ServerWithName =>
  ({ name, connectionStatus: "connected" }) as ServerWithName;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("summarizeColumn", () => {
  it("counts works / loaded for a host, skipping unloaded servers", () => {
    const a = [rep("claude", "works"), rep("codex", "blocked")];
    const b = [rep("claude", "works"), rep("codex", "degraded")];
    expect(summarizeColumn([a, b], "claude")).toEqual({ works: 2, loaded: 2 });
    expect(summarizeColumn([a, b], "codex")).toEqual({ works: 0, loaded: 2 });
    // An unloaded server (undefined) doesn't count toward the total.
    expect(summarizeColumn([a, undefined], "claude")).toEqual({
      works: 1,
      loaded: 1,
    });
    // A host with no report on any server → nothing loaded.
    expect(summarizeColumn([a, b], "cursor")).toEqual({ works: 0, loaded: 0 });
  });
});

describe("HostCompatMatrix", () => {
  it("renders per-column summaries and selects a server on row click", async () => {
    const onSelectServer = vi.fn();
    render(
      <HostCompatMatrix
        servers={[server("a"), server("b")]}
        selectedServerName="a"
        onSelectServer={onSelectServer}
      />,
    );

    // Both servers work on Claude (2/2); neither works on Codex (0/2).
    await waitFor(() => expect(screen.getByText("2/2")).toBeInTheDocument());
    expect(screen.getByText("0/2")).toBeInTheDocument();

    // Clicking server b's row selects it.
    fireEvent.click(screen.getByText("b").closest("tr")!);
    expect(onSelectServer).toHaveBeenCalledWith("b");
  });
});
