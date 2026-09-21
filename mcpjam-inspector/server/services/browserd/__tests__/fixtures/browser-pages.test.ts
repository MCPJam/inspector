/**
 * The fixture server itself, guarded in ordinary CI.
 *
 * The pages exist for the spike lane and for an eval, both of which are opt-in
 * — so without this the fixtures could rot for weeks and the first person to
 * discover it would be someone trying to reproduce a bug. These assertions are
 * cheap and they pin the properties the other suites rely on.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  FIXTURE_PATHS,
  startBrowserFixtures,
  type FixtureServer,
} from "./browser-pages";

let server: FixtureServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe("browser fixture pages", () => {
  it("serves every page it advertises", async () => {
    server = await startBrowserFixtures();
    for (const path of FIXTURE_PATHS) {
      const res = await fetch(server.url(path));
      expect(res.status, path).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect((await res.text()).length, path).toBeGreaterThan(100);
    }
  });

  it("answers /api/items with a 401 — the failure the page cannot show you", async () => {
    // The whole case for a network observe mode: this is what makes the list
    // empty, and the page catches it, so nothing reaches the console.
    server = await startBrowserFixtures();
    const res = await fetch(server.url("/api/items"));
    expect(res.status).toBe(401);
  });

  it("records what was asked for, so a test can assert the page's own requests", async () => {
    server = await startBrowserFixtures();
    await fetch(server.url("/form"));
    expect(server.requests).toContainEqual({ method: "GET", path: "/form" });
  });

  it("404s an unknown path rather than serving a page by accident", async () => {
    server = await startBrowserFixtures();
    expect((await fetch(server.url("/nope"))).status).toBe(404);
  });

  it("gives the form fields accessible names a ref can be built from", async () => {
    // The property the ref tests depend on: every input is `<label for>`-ed,
    // so the accessibility tree names it and a model can target it without
    // inventing a selector.
    server = await startBrowserFixtures();
    const html = await (await fetch(server.url("/form"))).text();
    for (const id of ["email", "password", "plan"]) {
      expect(html).toContain(`<label for="${id}"`);
    }
  });

  it("puts the banner OVER the button, which is what makes /covered a case", async () => {
    server = await startBrowserFixtures();
    const html = await (await fetch(server.url("/covered"))).text();
    expect(html).toContain("position:fixed");
    expect(html).toContain('id="buy"');
  });
});
