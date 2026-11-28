import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { linkRefusalPage, listLinkPickerProjects } from "../link-sign-in.js";

describe("linkRefusalPage", () => {
  it("gives the two causes a person can fix their own pages", () => {
    expect(linkRefusalPage("unknown_mcpjam_user")).toBe("no_account");
    expect(linkRefusalPage("org_unresolved")).toBe("no_organization");
  });

  it("shows the generic failure for every other reason, known or not", () => {
    for (const reason of [
      "not_an_org_member",
      "user_suspended",
      "token_invalid",
      "token_reused",
      "token_expired",
      "expired",
      "wrong_state",
      "something_new",
      undefined,
    ]) {
      expect(linkRefusalPage(reason)).toBe("failed");
    }
  });
});

describe("listLinkPickerProjects", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.stubEnv("CONVEX_HTTP_URL", "https://convex.test/");
    fetchMock = vi.fn(async () =>
      Response.json({
        data: [{ id: "p1", name: "Payments" }, { id: "p2" }, { name: "x" }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("reads the organization's projects with the person's own link token", async () => {
    const projects = await listLinkPickerProjects("link-token", "org_1");
    expect(projects).toEqual([
      { id: "p1", name: "Payments" },
      { id: "p2", name: "p2" },
    ]);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(
      "https://convex.test/v1/projects?organizationId=org_1",
    );
    expect((init as RequestInit).headers).toEqual({
      Authorization: "Bearer link-token",
    });
  });

  it("gives an empty list, never an error, when it can't ask or is refused", async () => {
    expect(await listLinkPickerProjects("link-token", undefined)).toEqual([]);
    fetchMock.mockResolvedValueOnce(new Response("no", { status: 401 }));
    expect(await listLinkPickerProjects("link-token", "org_1")).toEqual([]);
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    expect(await listLinkPickerProjects("link-token", "org_1")).toEqual([]);
    vi.stubEnv("CONVEX_HTTP_URL", "");
    expect(await listLinkPickerProjects("link-token", "org_1")).toEqual([]);
  });
});
