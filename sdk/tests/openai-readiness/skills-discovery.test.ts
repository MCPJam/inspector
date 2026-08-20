/**
 * Reading imported skills off a real server.
 *
 * `skills/list` returns what the server SAYS about each skill: its name, its
 * description, the digest it claims for its markdown. Three of this lane's
 * checks are about whether those claims are true — that the declared digest
 * matches the bytes actually served, that the markdown is within its size
 * limit, that the frontmatter agrees with the listing — and not one of them
 * can be answered from the listing alone. A gatherer that never fetched a body
 * would leave all three reporting `not-evaluated` forever: three checks that
 * exist and never fire.
 *
 * A socket rather than a stub, because the thing being tested is a two-method
 * conversation — the walk over `skills/list` pagination and then one
 * `skills/get` per skill — and a stub of the transport would be a stub of
 * exactly the part that can be wrong.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { discoverOpenAIImportedSkills } from "../../src/openai-readiness/discovery.js";

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections?.();
          server.close(() => resolve());
        }),
    ),
  );
});

/** Serve one JSON-RPC responder, returning the URL and the methods it saw. */
async function start(
  respond: (method: string, params: Record<string, unknown>) => unknown,
): Promise<{ url: string; calls: string[] }> {
  const calls: string[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const request = JSON.parse(body || "{}");
      calls.push(request.method);
      const result = respond(request.method, request.params ?? {});
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ jsonrpc: "2.0", id: request.id, result: result }),
      );
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/mcp`, calls };
}

const SKILL_MARKDOWN = [
  "---",
  "name: forecast",
  "description: Look up a forecast for any city",
  "---",
  "",
  "Ask for a city, then call get_forecast.",
].join("\n");

describe("discoverOpenAIImportedSkills", () => {
  it("fetches each skill's body, not just the listing", async () => {
    const { url, calls } = await start((method) =>
      method === "skills/list"
        ? {
            skills: [
              {
                name: "forecast",
                description: "Look up a forecast for any city",
                digest: "declared-digest",
              },
            ],
          }
        : { skill: { name: "forecast", content: SKILL_MARKDOWN } },
    );

    const evidence = await discoverOpenAIImportedSkills({
      enteredUrl: url,
      fetchFn: fetch,
    });

    expect(calls).toContain("skills/get");
    const [skill] = evidence.skills;
    // The three facts only a fetched body can establish.
    expect(skill.markdownBytes).toBe(
      new TextEncoder().encode(SKILL_MARKDOWN).length,
    );
    expect(skill.observedDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(skill.frontmatter).toMatchObject({
      name: "forecast",
      description: "Look up a forecast for any city",
    });
  });

  it("records a digest that disagrees with the listing rather than trusting it", async () => {
    // The whole point of fetching: the declared digest is a claim, and this is
    // where it stops being taken at face value.
    const { url } = await start((method) =>
      method === "skills/list"
        ? { skills: [{ name: "forecast", digest: "not-the-real-digest" }] }
        : { skill: { content: SKILL_MARKDOWN } },
    );
    const [skill] = (
      await discoverOpenAIImportedSkills({ enteredUrl: url, fetchFn: fetch })
    ).skills;
    expect(skill.declaredDigest).toBe("not-the-real-digest");
    expect(skill.observedDigest).not.toBe(skill.declaredDigest);
  });

  it("leaves the derived fields ABSENT when the body cannot be read", async () => {
    // A server that lists a skill and cannot serve it must not produce a skill
    // that looks measured. The error is recorded; nothing is inferred.
    const { url } = await start((method) =>
      method === "skills/list"
        ? { skills: [{ name: "forecast" }] }
        : { skill: { name: "forecast" } },
    );
    const [skill] = (
      await discoverOpenAIImportedSkills({ enteredUrl: url, fetchFn: fetch })
    ).skills;
    expect(skill.fetchError).toContain("no markdown body");
    expect(skill.observedDigest).toBeUndefined();
    expect(skill.markdownBytes).toBeUndefined();
    expect(skill.frontmatter).toBeUndefined();
  });

  it("sums pages into the total footprint the size limit grades", async () => {
    const page = "Extra detail, one page of it.";
    const { url } = await start((method) =>
      method === "skills/list"
        ? { skills: [{ name: "forecast" }] }
        : {
            skill: {
              content: SKILL_MARKDOWN,
              pages: [{ uri: "skill://forecast/detail", content: page }],
            },
          },
    );
    const [skill] = (
      await discoverOpenAIImportedSkills({ enteredUrl: url, fetchFn: fetch })
    ).skills;
    const encoder = new TextEncoder();
    expect(skill.pages).toEqual([
      { uri: "skill://forecast/detail", bytes: encoder.encode(page).length },
    ]);
    expect(skill.totalBytes).toBe(
      encoder.encode(SKILL_MARKDOWN).length + encoder.encode(page).length,
    );
  });

  it("walks pagination before fetching any body", async () => {
    // A server with six skills and a page size of five returns the sixth on
    // page two. A reader that stopped at page one would report five — under
    // the cap, passing a limit the submission actually exceeds.
    const { url } = await start((method, params) => {
      if (method !== "skills/list")
        return { skill: { content: SKILL_MARKDOWN } };
      return params.cursor
        ? { skills: [{ name: "f6" }] }
        : {
            skills: ["f1", "f2", "f3", "f4", "f5"].map((name) => ({ name })),
            nextCursor: "page-2",
          };
    });
    const evidence = await discoverOpenAIImportedSkills({
      enteredUrl: url,
      fetchFn: fetch,
    });
    expect(evidence.skills.map((skill) => skill.name)).toEqual([
      "f1",
      "f2",
      "f3",
      "f4",
      "f5",
      "f6",
    ]);
    expect(evidence.pagesWalked).toBe(2);
  });
});
