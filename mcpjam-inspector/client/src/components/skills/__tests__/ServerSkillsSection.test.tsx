/**
 * Two properties this section has to hold, both learned the hard way.
 *
 * 1. A catalog is a fact about a NEGOTIATED CONNECTION. `support.active` is
 *    `client advertised ∧ server declared`, and the client half comes from the
 *    hosted api-context, which hydrates asynchronously. A listing issued
 *    before it lands advertises the SDK defaults — which deliberately omit the
 *    skills extension — and answers `active: false` for a reason that stopped
 *    being true a moment later. Nothing used to re-run it, and the row it hid
 *    was where the only refresh button lived.
 *
 * 2. Provenance rides the ROW. There is no "From MCP servers" heading any
 *    more, so each row states the server it came from.
 *
 * 3. The row states what DISTINGUISHES it. Verification is mandatory, so a
 *    badge on every verified row said nothing; the manifest file count it
 *    carried said less. Both belong in the tooltip.
 */
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { listServerSkills, apiContext } = vi.hoisted(() => ({
  listServerSkills: vi.fn(),
  apiContext: { revision: 0, listeners: new Set<() => void>() },
}));

vi.mock("@/lib/apis/server-skills-api", () => ({
  listServerSkills: (...args: unknown[]) => listServerSkills(...args),
  getServerSkill: vi.fn(),
}));

vi.mock("@/lib/apis/web/context", () => ({
  getApiContextRevision: () => apiContext.revision,
  subscribeApiContext: (listener: () => void) => {
    apiContext.listeners.add(listener);
    return () => apiContext.listeners.delete(listener);
  },
}));

import { ServerSkillsSection } from "../ServerSkillsSection";

const SERVERS = [{ serverId: "s1", label: "staging", connected: true }];

function listing(active: boolean, names: string[] = [], files = 1) {
  return {
    support: {
      declared: true,
      advertised: active,
      directoryRead: false,
      active,
    },
    serverId: "s1",
    skills: names.map((name) => ({
      serverId: "s1",
      skillUri: `skill://mcpjam/${name}/SKILL.md`,
      name,
      description: `${name} description`,
      frontmatter: {},
      resources: Array.from({ length: files }, (_, index) => ({
        uri: `skill://mcpjam/${name}/file-${index}.md`,
        digest: "d",
      })),
    })),
    duplicateUris: [],
    rejected: [],
  };
}

/** Mirrors what the real context does when the host config lands. */
function bumpApiContext() {
  apiContext.revision += 1;
  for (const listener of apiContext.listeners) listener();
}

beforeEach(() => {
  apiContext.revision = 0;
  apiContext.listeners.clear();
  listServerSkills.mockReset();
});

afterEach(() => vi.clearAllMocks());

describe("ServerSkillsSection", () => {
  it("re-lists when the advertised capabilities change", async () => {
    // First answer: the host had not yet declared the extension.
    listServerSkills.mockResolvedValueOnce(listing(false));
    render(<ServerSkillsSection servers={SERVERS} projectId="p1" />);

    await waitFor(() => expect(listServerSkills).toHaveBeenCalledTimes(1));
    // Nothing is shown, correctly: this connection never had the conversation.
    expect(screen.queryByText("run-evals")).not.toBeInTheDocument();

    // The host config lands and the context re-negotiates.
    listServerSkills.mockResolvedValueOnce(listing(true, ["run-evals"]));
    bumpApiContext();

    await waitFor(() => expect(listServerSkills).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("run-evals")).toBeInTheDocument();
  });

  it("re-lists when the tab's refresh control fires", async () => {
    listServerSkills.mockResolvedValue(listing(true, ["run-evals"]));
    const { rerender } = render(
      <ServerSkillsSection servers={SERVERS} projectId="p1" refreshToken={0} />
    );
    await waitFor(() => expect(listServerSkills).toHaveBeenCalledTimes(1));

    rerender(
      <ServerSkillsSection servers={SERVERS} projectId="p1" refreshToken={1} />
    );
    await waitFor(() => expect(listServerSkills).toHaveBeenCalledTimes(2));
  });

  it("marks each row with the server it came from, under no heading", async () => {
    listServerSkills.mockResolvedValue(listing(true, ["run-evals"]));
    render(<ServerSkillsSection servers={SERVERS} projectId="p1" />);

    expect(await screen.findByText("run-evals")).toBeInTheDocument();
    // The origin is on the row itself, so it stays true wherever the row is
    // read — a heading only says it while you are underneath it.
    expect(screen.getByText("staging")).toBeInTheDocument();
    expect(screen.queryByText(/from mcp servers/i)).not.toBeInTheDocument();
  });

  it("keeps the manifest file count out of the row and in its tooltip", async () => {
    listServerSkills.mockResolvedValue(listing(true, ["run-evals"], 3));
    render(<ServerSkillsSection servers={SERVERS} projectId="p1" />);

    const row = await screen.findByRole("button", { name: /run-evals/ });
    // A bare "3" next to a shield rendered on every row and read as nothing.
    expect(row.textContent).not.toMatch(/\b3\b/);
    expect(row.getAttribute("title")).toBe(
      "skill://mcpjam/run-evals/SKILL.md \u00b7 3 file(s) in the advertised manifest"
    );
  });

  it("still marks the exception — a skill it declines to verify", async () => {
    const answer = listing(true, ["run-evals"]);
    answer.skills[0] = {
      ...answer.skills[0],
      unloadable: { reason: "no_resources", message: "no manifest" },
    } as (typeof answer.skills)[number];
    listServerSkills.mockResolvedValue(answer);
    render(<ServerSkillsSection servers={SERVERS} projectId="p1" />);

    expect(await screen.findByText(/unverifiable/)).toBeInTheDocument();
  });

  it("offers no load-by-URI field — that capability lives on the CLI", async () => {
    listServerSkills.mockResolvedValue(listing(true, ["run-evals"]));
    render(<ServerSkillsSection servers={SERVERS} projectId="p1" />);

    expect(await screen.findByText("run-evals")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/skill:\/\//)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^load$/i })
    ).not.toBeInTheDocument();
  });

  it("reports its row count so the tab can describe the whole list", async () => {
    listServerSkills.mockResolvedValue(listing(true, ["run-evals", "triage"]));
    const onListingChange = vi.fn();
    render(
      <ServerSkillsSection
        servers={SERVERS}
        projectId="p1"
        onListingChange={onListingChange}
      />
    );

    // Pending first: an unanswered listing is not an empty one, and the tab
    // would otherwise offer "upload your first skill" over rows about to land.
    expect(onListingChange).toHaveBeenCalledWith({ count: 0, pending: true });
    await waitFor(() =>
      expect(onListingChange).toHaveBeenLastCalledWith({
        count: 2,
        pending: false,
      })
    );
  });

  it("counts nothing for a server that never declared the extension", async () => {
    listServerSkills.mockResolvedValue(listing(false, ["run-evals"]));
    const onListingChange = vi.fn();
    render(
      <ServerSkillsSection
        servers={SERVERS}
        projectId="p1"
        onListingChange={onListingChange}
      />
    );

    await waitFor(() =>
      expect(onListingChange).toHaveBeenLastCalledWith({
        count: 0,
        pending: false,
      })
    );
  });

  it("renders nothing at all when no connected server declares it", async () => {
    listServerSkills.mockResolvedValue(listing(false));
    const { container } = render(
      <ServerSkillsSection servers={SERVERS} projectId="p1" />
    );
    await waitFor(() => expect(listServerSkills).toHaveBeenCalled());
    // "This host and server never had a skills conversation" is a different
    // fact from "this server has no skills"; a heading over nothing asserts
    // the second.
    await waitFor(() => expect(container.textContent).toBe(""));
  });
});
