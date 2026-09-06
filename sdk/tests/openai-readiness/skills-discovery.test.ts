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
import { sha256HexOfText } from "../../src/mcp-client-manager/skills-integrity.js";

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections?.();
          server.close(() => resolve());
        })
    )
  );
});

/** Serve one JSON-RPC responder, returning the URL and the methods it saw. */
async function start(
  respond: (method: string, params: Record<string, unknown>) => unknown
): Promise<{ url: string; calls: string[] }> {
  const calls: string[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const request = JSON.parse(body || "{}");
      calls.push(request.method);
      const answer = respond(request.method, request.params ?? {}) as Record<
        string,
        unknown
      >;
      res.writeHead(200, { "content-type": "application/json" });
      // A responder returning `{ error }` means a JSON-RPC ERROR, which belongs
      // at the top level of the envelope. Nesting it under `result` would make
      // it invisible to the reader and quietly turn an error test into a
      // success test.
      res.end(
        JSON.stringify(
          answer && "error" in answer
            ? { jsonrpc: "2.0", id: request.id, error: answer.error }
            : { jsonrpc: "2.0", id: request.id, result: answer }
        )
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
  it("reads current SEP-2640 entries by URI and fetches bytes via resources/read", async () => {
    const skillUri = "skill://forecast/SKILL.md";
    const pageUri = "skill://forecast/references/details.md";
    const page = "Use the city name exactly as entered.";
    const entry = {
      uri: skillUri,
      frontmatter: {
        name: "forecast",
        description: "Look up a forecast for any city",
      },
      resources: [
        {
          uri: skillUri,
          digest: `sha256:${await sha256HexOfText(SKILL_MARKDOWN)}`,
          size: new TextEncoder().encode(SKILL_MARKDOWN).length,
        },
        {
          uri: pageUri,
          digest: `sha256:${await sha256HexOfText(page)}`,
          size: new TextEncoder().encode(page).length,
        },
      ],
    };
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const { url } = await start((method, params) => {
      calls.push({ method, params });
      if (method === "skills/list") return { skills: [entry] };
      if (method === "skills/get") {
        return { resultType: "complete", skill: entry };
      }
      if (method === "resources/read" && params.uri === skillUri) {
        return { contents: [{ uri: skillUri, text: SKILL_MARKDOWN }] };
      }
      if (method === "resources/read" && params.uri === pageUri) {
        return { contents: [{ uri: pageUri, text: page }] };
      }
      return { error: { code: -32602, message: "unknown URI" } };
    });

    const evidence = await discoverOpenAIImportedSkills({
      enteredUrl: url,
      fetchFn: fetch,
    });

    expect(calls.map((call) => call.method)).toEqual([
      "skills/list",
      "skills/get",
      "resources/read",
    ]);
    expect(calls[1]?.params).toEqual({ uri: skillUri });
    expect(calls[2]?.params).toEqual({ uri: skillUri });
    expect(evidence.skills[0]).toMatchObject({
      name: "forecast",
      resourceUri: skillUri,
      declaredDigest: `sha256:${await sha256HexOfText(SKILL_MARKDOWN)}`,
      markdownBytes: new TextEncoder().encode(SKILL_MARKDOWN).length,
      observedDigest: await sha256HexOfText(SKILL_MARKDOWN),
      declaredPageCount: 1,
      pages: [{ uri: pageUri, bytes: new TextEncoder().encode(page).length }],
    });
    expect(evidence.skills[0]?.fetchError).toBeUndefined();
  });

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
        : { skill: { name: "forecast", content: SKILL_MARKDOWN } }
    );

    const evidence = await discoverOpenAIImportedSkills({
      enteredUrl: url,
      fetchFn: fetch,
    });

    expect(calls).toContain("skills/get");
    const [skill] = evidence.skills;
    // The three facts only a fetched body can establish.
    expect(skill.markdownBytes).toBe(
      new TextEncoder().encode(SKILL_MARKDOWN).length
    );
    expect(skill.observedDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(skill.frontmatter).toMatchObject({
      name: "forecast",
      description: "Look up a forecast for any city",
    });
  });

  it("parses frontmatter with real YAML, so a conforming server is not flagged", async () => {
    // REGRESSION: this ran through `parseYamlLite`, the deliberately-small
    // subset parser, while `checkFrontmatterDrift` compares the union of keys
    // on canonical JSON. Two divergences turned CONFORMING servers into
    // FRONTMATTER_AGREES violations: a nested map became `""`, and a block
    // scalar lost the trailing newline YAML preserves.
    const markdown = [
      "---",
      "name: forecast",
      "description: |",
      "  Look up a forecast",
      "  for any city.",
      "metadata:",
      "  author: acme",
      "---",
      "",
      "Body.",
    ].join("\n");
    const skillUri = "skill://forecast/SKILL.md";
    const declared = {
      name: "forecast",
      description: "Look up a forecast\nfor any city.\n",
      metadata: { author: "acme" },
    };
    const entry = {
      uri: skillUri,
      frontmatter: declared,
      resources: [
        {
          uri: skillUri,
          digest: `sha256:${await sha256HexOfText(markdown)}`,
          size: new TextEncoder().encode(markdown).length,
        },
      ],
    };
    const { url } = await start((method, params) => {
      if (method === "skills/list") return { skills: [entry] };
      if (method === "skills/get") return { skill: entry };
      if (method === "resources/read" && params.uri === skillUri) {
        return { contents: [{ uri: skillUri, text: markdown }] };
      }
      return {};
    });

    const evidence = await discoverOpenAIImportedSkills({
      enteredUrl: url,
      fetchFn: fetch,
    });
    const [skill] = evidence.skills;
    // Structurally equal to what the server declared — which is exactly what
    // the drift check compares, so it now agrees instead of reporting a
    // violation the server did not commit.
    expect(skill.frontmatter).toEqual(declared);
  });

  it("records a digest that disagrees with the listing rather than trusting it", async () => {
    // The whole point of fetching: the declared digest is a claim, and this is
    // where it stops being taken at face value.
    const { url } = await start((method) =>
      method === "skills/list"
        ? { skills: [{ name: "forecast", digest: "not-the-real-digest" }] }
        : { skill: { content: SKILL_MARKDOWN } }
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
        : { skill: { name: "forecast" } }
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
          }
    );
    const [skill] = (
      await discoverOpenAIImportedSkills({ enteredUrl: url, fetchFn: fetch })
    ).skills;
    const encoder = new TextEncoder();
    expect(skill.pages).toEqual([
      { uri: "skill://forecast/detail", bytes: encoder.encode(page).length },
    ]);
    expect(skill.totalBytes).toBe(
      encoder.encode(SKILL_MARKDOWN).length + encoder.encode(page).length
    );
  });

  for (const [label, declared] of [
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["a negative", -1],
    ["a fraction", 1.5],
    ["a string", "12"],
  ] as const) {
    it(`refuses ${label} as a declared page size`, async () => {
      // `page.bytes` comes off the SUBMITTED server's own response, and
      // `typeof x === "number"` admits NaN, Infinity and negatives. NaN is the
      // dangerous one: it propagates into the total, and a NaN total compares
      // `false` against every limit — so the size check this fetch exists to
      // feed would report a pass having measured nothing.
      const { url } = await start((method) =>
        method === "skills/list"
          ? { skills: [{ name: "forecast" }] }
          : {
              skill: {
                content: SKILL_MARKDOWN,
                pages: [{ uri: "skill://forecast/detail", bytes: declared }],
              },
            }
      );
      const [skill] = (
        await discoverOpenAIImportedSkills({ enteredUrl: url, fetchFn: fetch })
      ).skills;
      expect(skill.unmeasuredPages).toBe(1);
      // ABSENT rather than understated: a total that silently omits the page
      // nobody could size is below the real one, and the check reading it
      // would pass a skill that is over its limit.
      expect(skill.totalBytes).toBeUndefined();
    });
  }

  it("accepts a declared size that is a real byte count", async () => {
    const { url } = await start((method) =>
      method === "skills/list"
        ? { skills: [{ name: "forecast" }] }
        : {
            skill: {
              content: SKILL_MARKDOWN,
              pages: [{ uri: "skill://forecast/detail", bytes: 4096 }],
            },
          }
    );
    const [skill] = (
      await discoverOpenAIImportedSkills({ enteredUrl: url, fetchFn: fetch })
    ).skills;
    expect(skill.unmeasuredPages).toBeUndefined();
    expect(skill.totalBytes).toBe(
      new TextEncoder().encode(SKILL_MARKDOWN).length + 4096
    );
  });

  it("records how many pages the server DECLARED, past the read cap", async () => {
    // The read cap bounds what this run fetches; it is not a statement about
    // the skill. Losing the declared count made the page-count limit check
    // structurally incapable of firing — `pages.length` can never exceed a cap
    // the loop enforces.
    const { url } = await start((method) =>
      method === "skills/list"
        ? { skills: [{ name: "forecast" }] }
        : {
            skill: {
              content: SKILL_MARKDOWN,
              pages: Array.from({ length: 25 }, (_unused, index) => ({
                uri: `skill://forecast/${index}`,
                content: "detail",
              })),
            },
          }
    );
    const [skill] = (
      await discoverOpenAIImportedSkills({ enteredUrl: url, fetchFn: fetch })
    ).skills;
    expect(skill.declaredPageCount).toBe(25);
    expect(skill.pages?.length).toBe(10);
    // The 15 pages past the cap were never read, so the total is absent rather
    // than a figure that silently omits them.
    expect(skill.unmeasuredPages).toBe(15);
    expect(skill.totalBytes).toBeUndefined();
  });

  it("records the error when the walk stops part-way, keeping what it read", async () => {
    // The other half of the contract the caps and digest checks now depend on:
    // a `skills/list` error on page two must be REPORTED, not swallowed, or
    // the grader has no way to know the listing it received is partial.
    const { url } = await start((method, params) => {
      if (method !== "skills/list") {
        return { skill: { content: SKILL_MARKDOWN } };
      }
      return params.cursor
        ? { error: { code: -32000, message: "listing backend unavailable" } }
        : { skills: [{ name: "forecast" }], nextCursor: "page-2" };
    });
    const evidence = await discoverOpenAIImportedSkills({
      enteredUrl: url,
      fetchFn: fetch,
    });
    expect(evidence.listError).toContain("listing backend unavailable");
    // Page one's skill is kept — it is real evidence, just not all of it.
    expect(evidence.skills.map((skill) => skill.name)).toEqual(["forecast"]);
    // And this is NOT the page-cap case, which is the whole reason the grader
    // cannot key "incomplete" off `paginationCapHit` alone.
    expect(evidence.paginationCapHit).toBeUndefined();
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
