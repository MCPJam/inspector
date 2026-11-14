import { describe, expect, it, vi } from "vitest";
import { PlatformApiClient } from "../client.js";
import {
  getEvalRunDisclosureOperation,
  runEvalCaseOperation,
  runEvalSuiteOperation,
} from "../operations.js";

const project = { id: "p1", name: "Project", organizationId: "org1" };
const suite = { id: "s1", name: "Suite", projectId: "p1" };

function fixture(
  environmentIds = ["env1"],
  hosts: Array<{ id: string; name: string }> = []
) {
  const writes: unknown[] = [];
  const reads: string[] = [];
  const urls: URL[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    urls.push(url);
    const path = url.pathname;
    reads.push(path);
    if (init?.method === "POST") {
      writes.push(JSON.parse(String(init.body)));
      return Response.json({ runId: "run1", status: "running", servers: [] });
    }
    if (path.endsWith("/projects")) return Response.json({ items: [project] });
    if (path.endsWith("/eval-suites")) return Response.json({ items: [suite] });
    if (path.endsWith("/eval-suites/s1"))
      return Response.json({ ...suite, hosts, environmentIds });
    if (path.endsWith("/cases"))
      return Response.json({
        items: [{ id: "case1", title: "Case", suiteId: "s1" }],
      });
    if (path.endsWith("/clients"))
      return Response.json({
        items: [
          { id: "client1", name: "Codex" },
          { id: "other", name: "Other" },
        ],
      });
    if (path.endsWith("/environments/failed"))
      return Response.json(
        { code: "INTERNAL_ERROR", message: "Lookup failed" },
        { status: 500 }
      );
    if (/\/environments\/env/.test(path))
      return Response.json({
        id: path.split("/").pop(),
        name: path.endsWith("env2") ? "Second profile" : null,
        adhoc: !path.endsWith("env2"),
        hostId: "client1",
      });
    if (path.endsWith("/environments")) return Response.json({ items: [] });
    if (path.endsWith("/run-disclosure"))
      return Response.json({ contractVersion: 1 });
    throw new Error(`Unexpected request ${path}`);
  });
  const client = new PlatformApiClient({
    baseUrl: "https://example.test/api/v1",
    getAuth: () => "test-key",
    fetch,
  });
  return { client, writes, reads, urls };
}

describe("environment-backed suite client selectors", () => {
  it.each(["client1", "Codex"])(
    "launches the attached unnamed environment selected by %s",
    async (clientSelector) => {
      const f = fixture();
      await runEvalSuiteOperation.execute(
        { project: "p1", suite: "s1", client: clientSelector },
        f
      );
      expect(f.writes).toEqual([
        expect.objectContaining({ environmentId: "env1" }),
      ]);
      expect(f.writes[0]).not.toHaveProperty("namedHostId");
      expect(f.reads).toContain("/api/v1/projects/p1/environments/env1");
    }
  );

  it("does not hide an environment lookup failure", async () => {
    const f = fixture(["failed", "env1"]);
    await expect(
      runEvalSuiteOperation.execute(
        { project: "p1", suite: "s1", client: "client1" },
        f
      )
    ).rejects.toThrow("Lookup failed");
    expect(f.writes).toEqual([]);
  });

  it("lists every matching environment and launches nothing when the client is ambiguous", async () => {
    const f = fixture(["env1", "env2"]);
    await expect(
      runEvalSuiteOperation.execute(
        { project: "p1", suite: "s1", client: "client1" },
        f
      )
    ).rejects.toThrow(/TARGET_REQUIRED: .*env1.*Second profile.*env2/);
    expect(f.writes).toEqual([]);
  });

  it("keeps the missing-attachment refusal for a client with no attached environment", async () => {
    const f = fixture();
    await expect(
      runEvalSuiteOperation.execute(
        { project: "p1", suite: "s1", client: "other" },
        f
      )
    ).rejects.toThrow("has no attached hosts");
    expect(f.writes).toEqual([]);
  });

  it("preserves direct host attachments without environment lookups", async () => {
    const f = fixture([], [{ id: "client1", name: "Codex" }]);
    await runEvalSuiteOperation.execute(
      { project: "p1", suite: "s1", client: "Codex" },
      f
    );
    expect(f.writes).toEqual([
      expect.objectContaining({ namedHostId: "client1" }),
    ]);
    expect(f.reads.some((path) => path.includes("/environments/"))).toBe(false);
  });

  it.each(["client1", "Codex"])(
    "runs a single case through the environment of client %s",
    async (clientSelector) => {
      const f = fixture();
      await runEvalCaseOperation.execute(
        { project: "p1", suite: "s1", case: "case1", client: clientSelector },
        f
      );
      expect(f.writes).toEqual([
        expect.objectContaining({ environmentId: "env1", caseIds: ["case1"] }),
      ]);
      expect(f.writes[0]).not.toHaveProperty("namedHostId");
    }
  );

  it("refuses a single case for a client with no attached environment", async () => {
    const f = fixture();
    await expect(
      runEvalCaseOperation.execute(
        { project: "p1", suite: "s1", case: "case1", client: "other" },
        f
      )
    ).rejects.toThrow("has no attached hosts");
    expect(f.writes).toEqual([]);
  });

  it("discloses the same environment that a client-targeted run launches", async () => {
    const f = fixture();
    await getEvalRunDisclosureOperation.execute(
      { project: "p1", suite: "s1", host: "client1" },
      f
    );
    const call = f.urls.find((url) => url.pathname.endsWith("/run-disclosure"));
    expect(call?.searchParams.get("environmentId")).toBe("env1");
    expect(call?.searchParams.has("namedHostId")).toBe(false);
    expect(f.writes).toEqual([]);
  });
});
