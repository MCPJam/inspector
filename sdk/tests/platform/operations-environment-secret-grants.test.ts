/**
 * `secretSelection` on the environment operations — the field that grants a
 * project secret to the runs an environment launches.
 *
 * Both halves of this were live bugs, and both were SILENT in the way that
 * costs the most time: the create input schema strips unknown keys, so a
 * `secretSelection` it did not declare vanished between the caller and the
 * wire and the environment came back with no grant; and the update input's
 * at-least-one-field refine did not list it, so a PATCH that changed only the
 * grant was rejected client-side with a message that did not even name the
 * field the caller had passed.
 *
 * The API and the `/api/v1` route accepted the field the whole time — only
 * these schemas did not — so the tests assert what reaches the WIRE, not just
 * that parsing succeeds.
 */
import { describe, expect, it, vi } from "vitest";
import {
  createEnvironmentOperation,
  PlatformApiClient,
  updateEnvironmentOperation,
} from "../../src/platform/index.js";

const PROJECT = {
  id: "project-1",
  name: "Acme",
  description: null,
  icon: null,
  organizationId: "org-a",
  visibility: null,
  createdAt: 1,
  updatedAt: 1,
};

const ENVIRONMENT = {
  id: "env-live",
  projectId: PROJECT.id,
  name: "Cursor Harness",
  hostId: "host-1",
  revision: 4,
  archived: false,
  createdAt: 1,
  updatedAt: 2,
};

const GRANT = {
  mode: "explicit" as const,
  secretIds: ["secret-cursor-api-key"],
};

/** The bodies the operations actually PUT on the wire, in call order. */
function makeClient(): {
  client: PlatformApiClient;
  bodies: Array<{ method: string; body: Record<string, unknown> }>;
} {
  const bodies: Array<{ method: string; body: Record<string, unknown> }> = [];
  const fetchMock = vi.fn(async (target: unknown, init?: RequestInit) => {
    const path = new URL(String(target)).pathname;
    if (path === "/api/v1/projects") return Response.json({ items: [PROJECT] });
    if (/^\/api\/v1\/projects\/[^/]+\/environments$/.test(path)) {
      if (init?.method === "POST") {
        bodies.push({
          method: "POST",
          body: JSON.parse(String(init.body)) as Record<string, unknown>,
        });
        return Response.json({ ...ENVIRONMENT, secretSelection: GRANT });
      }
      return Response.json({ items: [ENVIRONMENT] });
    }
    if (/^\/api\/v1\/projects\/[^/]+\/environments\/[^/]+$/.test(path)) {
      if (init?.method === "PATCH") {
        bodies.push({
          method: "PATCH",
          body: JSON.parse(String(init.body)) as Record<string, unknown>,
        });
        return Response.json({ ...ENVIRONMENT, revision: 5 });
      }
      return Response.json(ENVIRONMENT);
    }
    return Response.json(
      { code: "NOT_FOUND", message: `No route for ${path}` },
      { status: 404 }
    );
  });
  const client = new PlatformApiClient({
    baseUrl: "https://api.example.com/api/v1",
    getAuth: () => "sk_test",
    fetch: fetchMock as unknown as typeof fetch,
  });
  return { client, bodies };
}

describe("create_project_environment secretSelection", () => {
  it("keeps the grant through parsing instead of stripping it", () => {
    const result = createEnvironmentOperation.inputSchema.safeParse({
      name: "Cursor Harness",
      hostId: "host-1",
      secretSelection: GRANT,
    });

    expect(result.success).toBe(true);
    // The schema strips what it does not declare, so an undeclared field
    // parsed "successfully" and then simply was not there.
    expect(result.data?.secretSelection).toEqual(GRANT);
  });

  it("forwards the grant to the create call", async () => {
    const { client, bodies } = makeClient();

    await createEnvironmentOperation.execute(
      { name: "Cursor Harness", hostId: "host-1", secretSelection: GRANT },
      { client }
    );

    expect(bodies[0]?.method).toBe("POST");
    expect(bodies[0]?.body.secretSelection).toEqual(GRANT);
  });

  it("omits the field entirely when no grant is asked for", async () => {
    const { client, bodies } = makeClient();

    await createEnvironmentOperation.execute(
      { name: "Cursor Harness", hostId: "host-1" },
      { client }
    );

    expect(bodies[0]?.body).not.toHaveProperty("secretSelection");
  });

  it("rejects an empty secretIds list — no grant is omission, not []", () => {
    const result = createEnvironmentOperation.inputSchema.safeParse({
      name: "Cursor Harness",
      hostId: "host-1",
      secretSelection: { mode: "explicit", secretIds: [] },
    });

    expect(result.success).toBe(false);
  });
});

describe("update_project_environment secretSelection", () => {
  const BASE = { environment: "env-live", expectedRevision: 4 };

  it("satisfies the at-least-one-field refine on its own", () => {
    const result = updateEnvironmentOperation.inputSchema.safeParse({
      ...BASE,
      secretSelection: GRANT,
    });

    expect(result.success).toBe(true);
  });

  it("names itself in the refine message, so the list is not a lie", () => {
    const result = updateEnvironmentOperation.inputSchema.safeParse(BASE);

    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("secretSelection");
  });

  it("forwards a grant as a replacement", async () => {
    const { client, bodies } = makeClient();

    await updateEnvironmentOperation.execute(
      { ...BASE, secretSelection: GRANT },
      { client }
    );

    expect(bodies[0]?.method).toBe("PATCH");
    expect(bodies[0]?.body.secretSelection).toEqual(GRANT);
  });

  it("forwards an explicit null as a REVOKE", async () => {
    const { client, bodies } = makeClient();

    await updateEnvironmentOperation.execute(
      { ...BASE, secretSelection: null },
      { client }
    );

    // `null` has to survive as null: the tri-state is omitted = unchanged,
    // null = revoke, value = replace, and a truthiness check would drop the
    // revoke on the floor.
    expect(bodies[0]?.body).toHaveProperty("secretSelection", null);
  });

  it("leaves the grant alone when the PATCH does not mention it", async () => {
    const { client, bodies } = makeClient();

    await updateEnvironmentOperation.execute(
      { ...BASE, name: "Renamed" },
      { client }
    );

    expect(bodies[0]?.body).not.toHaveProperty("secretSelection");
  });

  it("rejects an empty secretIds list — revoking is null", () => {
    const result = updateEnvironmentOperation.inputSchema.safeParse({
      ...BASE,
      secretSelection: { mode: "explicit", secretIds: [] },
    });

    expect(result.success).toBe(false);
  });
});

// The siblings the same refine/forwarding gap would hit. They round-trip
// today; this locks that in so the next clearable field added to the route
// cannot quietly land on only one side again.
describe("clearable siblings still round-trip", () => {
  it.each([
    ["skillSelection", { mode: "explicit", skillIds: ["skill-a"] }],
    ["pluginVersionIds", ["plugin-version-1"]],
    ["sandboxImageId", "image-1"],
  ] as const)(
    "%s survives create and can be the only PATCH field",
    (field, value) => {
      const created = createEnvironmentOperation.inputSchema.safeParse({
        name: "Cursor Harness",
        hostId: "host-1",
        [field]: value,
      });
      expect(created.success).toBe(true);
      expect(created.data?.[field]).toEqual(value);

      const patched = updateEnvironmentOperation.inputSchema.safeParse({
        environment: "env-live",
        expectedRevision: 4,
        [field]: value,
      });
      expect(patched.success).toBe(true);

      const cleared = updateEnvironmentOperation.inputSchema.safeParse({
        environment: "env-live",
        expectedRevision: 4,
        [field]: null,
      });
      expect(cleared.success).toBe(true);
    }
  );
});
