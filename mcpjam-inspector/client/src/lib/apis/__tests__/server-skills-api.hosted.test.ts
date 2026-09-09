/**
 * The hosted "From MCP servers" calls must carry what a hosted per-server
 * request carries — which is what `buildServerRequest` assembles.
 *
 * Two of its fields are load-bearing here, and this module used to build its
 * own body without either:
 *
 *   - `clientCapabilities`. Absent, the ephemeral connection falls back to the
 *     SDK defaults, which deliberately omit `io.modelcontextprotocol/skills`.
 *     The connection then never advertises the extension, `support.active` is
 *     false on every server, and the section renders nothing.
 *   - the RESOLVED server id. A display name reaches Convex `authorizeBatch`
 *     and fails argument validation there, before any MCP frame is sent.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const webPostMock = vi.fn();
const buildServerRequestMock = vi.fn();

vi.mock("@/lib/config", () => ({ HOSTED_MODE: true }));

vi.mock("@/lib/apis/web/base", () => ({
  webPost: (...args: unknown[]) => webPostMock(...args),
}));

vi.mock("@/lib/apis/web/context", () => ({
  buildServerRequest: (...args: unknown[]) => buildServerRequestMock(...args),
}));

vi.mock("@/lib/session-token", () => ({ authFetch: vi.fn() }));

import {
  getServerSkill,
  listServerSkills,
  readServerSkillFile,
} from "../server-skills-api";

/** A representative builder output, including the two fields that matter. */
const BUILT = {
  projectId: "project-1",
  serverId: "p17abc",
  serverName: "staging",
  clientCapabilities: {
    extensions: { "io.modelcontextprotocol/skills": {} },
  },
  clientInfo: { name: "mcpjam-inspector", version: "0.0.0" },
};

beforeEach(() => {
  vi.clearAllMocks();
  buildServerRequestMock.mockReturnValue({ ...BUILT });
});

describe("server-skills-api — hosted request body", () => {
  it("lists through buildServerRequest, keyed by the server NAME", async () => {
    webPostMock.mockResolvedValueOnce({ skills: [] });

    await listServerSkills({ serverId: "staging", projectId: "project-1" });

    // The section speaks names; the builder is what resolves one to an id.
    expect(buildServerRequestMock).toHaveBeenCalledWith("staging");
    expect(webPostMock).toHaveBeenCalledWith(
      "/api/web/server-skills/list",
      BUILT
    );
  });

  it("carries the host's declared skills capability", async () => {
    webPostMock.mockResolvedValueOnce({ skills: [] });

    await listServerSkills({ serverId: "staging", projectId: "project-1" });

    const body = webPostMock.mock.calls[0]?.[1] as Record<string, any>;
    // Advertise = enforce. Without this the connection cannot be mutually
    // declaring, so every server answers `support.active: false`.
    expect(
      body.clientCapabilities?.extensions?.["io.modelcontextprotocol/skills"]
    ).toBeDefined();
    // And never the display name, which `authorizeBatch` rejects outright.
    expect(body.serverId).toBe("p17abc");
  });

  it("adds only the route's own fields to the built body", async () => {
    webPostMock.mockResolvedValueOnce({ skill: { name: "s" } });
    await getServerSkill({
      serverId: "staging",
      uri: "skill://mcpjam/s/SKILL.md",
      projectId: "project-1",
    });
    expect(webPostMock).toHaveBeenCalledWith("/api/web/server-skills/get", {
      ...BUILT,
      uri: "skill://mcpjam/s/SKILL.md",
    });

    webPostMock.mockResolvedValueOnce({ file: { uri: "u", text: "", digest: "d" } });
    await readServerSkillFile({
      serverId: "staging",
      skillUri: "skill://mcpjam/s/SKILL.md",
      resourceUri: "skill://mcpjam/s/references/a.md",
      projectId: "project-1",
    });
    expect(webPostMock).toHaveBeenCalledWith(
      "/api/web/server-skills/read-file",
      {
        ...BUILT,
        skillUri: "skill://mcpjam/s/SKILL.md",
        resourceUri: "skill://mcpjam/s/references/a.md",
      }
    );
  });

  it("returns an inactive-support listing rather than calling without a project", async () => {
    const result = await listServerSkills({ serverId: "staging" });

    expect(webPostMock).not.toHaveBeenCalled();
    expect(result.support.active).toBe(false);
    expect(result.skills).toEqual([]);
  });
});
