/**
 * The one contract the trace-destinations surface cannot be allowed to break:
 * NO ROUTE RETURNS A HEADER VALUE.
 *
 * Asserted on the TYPES AND THE MAPPER, not on sample bodies. A sample body
 * only proves what one fixture happened not to contain — it passes just as
 * happily the day someone adds a `headers` field that this particular row left
 * empty. The declaration is the promise, so the declaration is what is checked,
 * in each of the three places it is written down:
 *
 *   1. the route module's mirror of the Convex view type;
 *   2. the route module's own DTO mapper, read as source;
 *   3. the SDK's `PlatformTraceDestination`, which is what a typed caller sees.
 *
 * The three are separate on purpose. Any one of them could grow a headers field
 * without the other two noticing, and each is the only thing some consumer
 * reads.
 *
 * THE FOURTH PLACE — the OpenAPI response schemas — is deliberately absent, and
 * that absence is itself checked below. These routes are not in the public spec
 * while availability is decided per organization; `docs/README.md` requires
 * that, and `openapi-drift.test.ts` holds the baseline entry with the reason.
 * When the flag comes off and the schemas land, this file gains the same
 * schema-walking assertion `secrets-write-only.test.ts` runs.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..", "..");
const OPENAPI_PATH = join(REPO_ROOT, "docs", "reference", "openapi.json");
const SDK_TYPES_PATH = join(REPO_ROOT, "sdk", "src", "platform", "types.ts");
const SDK_CLIENT_PATH = join(REPO_ROOT, "sdk", "src", "platform", "client.ts");
const ROUTE_PATH = join(import.meta.dirname, "..", "trace-destinations.ts");

/** Field names that would mean the surface hands a credential back. */
const FORBIDDEN = ["headers", "headerValues", "plaintext", "ciphertext"];

/** The body of a named `interface` / `type` / `function`, up to its closing brace. */
function declarationBody(source: string, opener: string): string {
  const start = source.indexOf(opener);
  expect(start, `${opener} was renamed or removed`).toBeGreaterThan(-1);
  const end = source.indexOf("\n}", start);
  expect(end, `${opener} has no closing brace`).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("the trace-destinations surface is write-only for header values", () => {
  it("keeps header values out of the route's mirror of the Convex view", () => {
    const body = declarationBody(
      readFileSync(ROUTE_PATH, "utf8"),
      "type TraceDestinationRow = {",
    );
    for (const forbidden of FORBIDDEN) {
      expect(
        new RegExp(`^\\s*${forbidden}\\??:`, "m").test(body),
        `TraceDestinationRow declares \`${forbidden}\``,
      ).toBe(false);
    }
    // Guards the guard: if the mirror were empty or the slice wrong, the loop
    // above would pass vacuously forever.
    expect(body).toContain("headerNames");
  });

  it("keeps header values out of the route's own DTO mapper", () => {
    const body = declarationBody(
      readFileSync(ROUTE_PATH, "utf8"),
      "function toTraceDestinationDto(",
    );
    for (const forbidden of FORBIDDEN) {
      expect(
        new RegExp(`\\b${forbidden}\\s*:`).test(body),
        `toTraceDestinationDto emits \`${forbidden}\``,
      ).toBe(false);
    }
    expect(body).toContain("headerNames");
  });

  it("keeps header values out of the SDK's PlatformTraceDestination", () => {
    const body = declarationBody(
      readFileSync(SDK_TYPES_PATH, "utf8"),
      "export interface PlatformTraceDestination {",
    );
    for (const forbidden of FORBIDDEN) {
      expect(
        new RegExp(`^\\s*${forbidden}\\??:`, "m").test(body),
        `PlatformTraceDestination declares \`${forbidden}\``,
      ).toBe(false);
    }
    expect(body).toContain("headerNames");
  });

  it("DOES accept headers on the two write calls, so the checks above are real", () => {
    // If the surface could not take a header value at all, every assertion
    // above would be true for an uninteresting reason.
    const source = readFileSync(SDK_CLIENT_PATH, "utf8");
    for (const method of [
      "createTraceDestination(",
      "updateTraceDestination(",
    ]) {
      const start = source.indexOf(`  ${method}`);
      expect(start, `${method} was renamed or removed`).toBeGreaterThan(-1);
      const body = source.slice(start, source.indexOf("\n  }", start));
      expect(body, `${method} does not accept headers`).toContain(
        "headers?: Record<string, string>",
      );
    }
  });

  it("stays out of the public spec while the feature is gated per organization", () => {
    // Not a style rule: `docs/README.md` says a feature enforced per
    // organization must not be documented until the flag comes off, and its
    // routes are correspondingly kept out of the spec. The reason lives in
    // `openapi-drift.test.ts`'s baseline, which fails if a route here is
    // neither documented nor listed there — so this assertion and that one
    // close the loop from both ends.
    const openapi = readFileSync(OPENAPI_PATH, "utf8");
    expect(openapi).not.toContain("trace-destinations");
    expect(openapi).not.toContain("TraceDestination");
  });

  it("enforces the organization path segment rather than trusting the id", () => {
    // Convex checks membership against the destination's OWN organization, so
    // no caller can read one they do not belong to. But a member of TWO
    // organizations could name org A in the URL and address a destination in
    // org B, and a route whose path does not mean what it says is a bug
    // waiting for the caller that scripts against it. The check reads as a
    // 404: at this address, that id is simply not there.
    const body = declarationBody(
      readFileSync(ROUTE_PATH, "utf8"),
      "async function readDestination(",
    );
    expect(body).toContain("row.organizationId !== organizationId");
    expect(body).toContain("ErrorCode.NOT_FOUND");

    // And every by-id route passes the segment in, or the check above guards
    // nothing: a call site that omitted it would not compile, but one that
    // passed the WRONG thing (a destination id twice, say) would.
    const source = readFileSync(ROUTE_PATH, "utf8");
    const callSites = source
      .split("await readDestination(")
      .slice(1)
      .map((chunk) => chunk.slice(0, chunk.indexOf(");")));

    expect(callSites.length).toBeGreaterThanOrEqual(6);
    for (const args of callSites) {
      expect(args, `readDestination(${args}) omits the organization`).toMatch(
        /organizationId/,
      );
    }
  });

  it("decides scope before serving any caller-supplied destination id", () => {
    // Two things have to hold on every by-id route, and they are different.
    //
    // SCOPE IS DECIDED FIRST — by a preflight (`assertDestinationInOrg`) or,
    // where the read IS the response, by a scoping read. A route that read the
    // row, acted on it, and only then checked the organization would mutate
    // another org's destination and report 404 afterwards.
    //
    // AND THAT DECISION ANSWERS 404 — `isScopingPreflight`. Without it a
    // refusal the gateway cannot attribute surfaces as 502, which
    // distinguishes "no such id" from "exists, elsewhere" and pages someone
    // per probe. The re-reads that follow a decision deliberately stay 502:
    // there a 404 would tell a caller the destination they just wrote does
    // not exist, when the read simply failed.
    const source = readFileSync(ROUTE_PATH, "utf8");
    const handlers = source
      .split(/traceDestinations\.(?:get|post|patch|delete)\(/)
      .slice(1);

    const byId = handlers.filter((body) =>
      body.includes('c.req.param("destinationId")'),
    );
    expect(byId.length).toBeGreaterThanOrEqual(8);

    for (const body of byId) {
      const path = body.slice(0, body.indexOf('",'));
      const preflights = body.includes("assertDestinationInOrg(");
      const scopingRead = /readDestination\([^;]*?\btrue\b/s.test(body);
      expect(
        preflights || scopingRead,
        `${path} serves a caller-supplied id without deciding scope first`,
      ).toBe(true);
    }

    // And the preflight itself is a scoping read, or every route above
    // inherits a 502 for a refusal that should read as 404.
    expect(source).toMatch(
      /async function assertDestinationInOrg[\s\S]*?readDestination\([^;]*?\btrue\b/,
    );
  });

  it("is absent from the guest allowlist, so guests cannot reach it", () => {
    // `guest-allowed-paths.ts` is default-deny, so this is not "no rule denies
    // it" — it is "no rule ADMITS it". A single added entry would be the one
    // change that breaks the guarantee, and this is what would catch it.
    const source = readFileSync(
      join(import.meta.dirname, "..", "guest-allowed-paths.ts"),
      "utf8",
    );
    expect(source).not.toContain("/trace-destinations");
  });
});
