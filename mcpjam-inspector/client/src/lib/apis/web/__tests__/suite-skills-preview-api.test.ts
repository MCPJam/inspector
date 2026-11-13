import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchSuiteSkillsPreview } from "../suite-skills-preview-api";

const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn<typeof fetch>() }));
vi.mock("@/lib/session-token", () => ({ authFetch }));

const request = { projectId: "proj", environmentIds: ["env-a", "env-b"] };

describe("fetchSuiteSkillsPreview", () => {
  beforeEach(() => authFetch.mockReset());

  it("reads every environment in one request, a refused one as its own entry", async () => {
    authFetch.mockResolvedValue(
      Response.json({
        environments: [
          {
            environmentId: "env-a",
            ok: true,
            preview: {
              deliveredCount: 1,
              skills: [
                {
                  skillId: "ss1",
                  name: "docs/search",
                  description: "Search the docs.",
                  channels: ["mcp-server"],
                  reason: null,
                  origin: { kind: "mcp-server", server: "Docs" },
                  version: { number: 2 },
                },
              ],
            },
          },
          {
            environmentId: "env-b",
            ok: false,
            error: { status: 404, message: "Environment not found" },
          },
        ],
      }),
    );
    const controller = new AbortController();
    const result = await fetchSuiteSkillsPreview(request, controller.signal);
    expect(authFetch).toHaveBeenCalledOnce();
    const [url, init] = authFetch.mock.calls[0]!;
    expect(url).toBe("/api/web/environments/skills-preview/suite");
    expect(init).toMatchObject({ method: "POST", signal: controller.signal });
    expect(JSON.parse(String(init?.body))).toEqual(request);
    expect(result.environments.map((entry) => entry.ok)).toEqual([true, false]);
    const [first] = result.environments;
    expect(first?.ok && first.preview.skills[0]?.origin).toEqual({
      kind: "mcp-server",
      server: "Docs",
    });
  });

  it("throws with the status when the read fails", async () => {
    authFetch.mockResolvedValue(new Response(null, { status: 503 }));
    await expect(fetchSuiteSkillsPreview(request)).rejects.toMatchObject({
      message: "Couldn’t load the skills preview. Try again.",
      cause: { status: 503 },
    });
  });
});
