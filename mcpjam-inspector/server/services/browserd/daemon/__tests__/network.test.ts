/**
 * The network ring — what it keeps, and more importantly what it does not.
 *
 * The retention rules are the whole design: a ring of request metadata is a
 * log of everywhere a browser has been, and the browser it is recording is
 * signed into things. So these pin the absences as hard as the presences.
 */
import { describe, expect, it } from "vitest";
import {
  NetworkRing,
  RETAINED_HEADERS,
  capNetwork,
  retainHeaders,
  sanitizeNetworkUrl,
} from "../network";

describe("sanitizeNetworkUrl", () => {
  it("drops the query and the fragment, which is where the secrets are", () => {
    // A reset link, a session token, a search term someone typed. The path is
    // what identifies the request; the rest is dropped rather than redacted,
    // because a redaction has to know what it is looking for.
    expect(sanitizeNetworkUrl("https://x.test/reset?token=abc123#step=2")).toBe(
      "https://x.test/reset",
    );
  });

  it("drops inline credentials", () => {
    expect(sanitizeNetworkUrl("https://user:pw@x.test/a")).toBe(
      "https://x.test/a",
    );
  });

  it("keeps no location at all for a data URL, because it IS its content", () => {
    expect(sanitizeNetworkUrl("data:text/html,<h1>hi</h1>")).toBe("data:…");
  });

  it("keeps a bounded prefix of something unparseable rather than nothing", () => {
    // A malformed request should still be identifiable in the list.
    expect(sanitizeNetworkUrl("not a url at all")).toBe("not a url at all");
  });
});

describe("retainHeaders", () => {
  it("keeps only the allowlist, so a credential is never dropped BY A RULE", () => {
    // The distinction that matters: `set-cookie` is not absent because
    // something remembered to remove it. It is absent because nothing copies
    // it in, which is the version that survives a server inventing a new
    // header name next week.
    const kept = retainHeaders({
      "Content-Type": "application/json",
      "set-cookie": "session=abc",
      authorization: "Bearer sk-live-1",
      "x-api-key": "k",
      "x-request-id": "req-9",
    });
    expect(kept).toEqual({
      "content-type": "application/json",
      "x-request-id": "req-9",
    });
  });

  it("carries no credential-bearing name in the allowlist itself", () => {
    for (const name of ["authorization", "cookie", "set-cookie", "x-api-key"]) {
      expect(RETAINED_HEADERS).not.toContain(name);
    }
  });

  it("SANITIZES `location`, which is a URL and the one that carries the secret", () => {
    // Review catch. `location` was retained verbatim, so an OAuth hop handed
    // back `?code=…&state=…` — exactly what stripping the query off `url`
    // exists to remove, arriving one field over. A reset link is the same
    // shape.
    const kept = retainHeaders({
      location: "https://idp.test/cb?code=SECRET&state=xyz#tok=also-secret",
    });
    expect(kept!.location).toBe("https://idp.test/cb");
    expect(JSON.stringify(kept)).not.toContain("SECRET");
  });

  it("bounds a header value", () => {
    const kept = retainHeaders({ "content-type": "x".repeat(2_000) });
    expect(kept!["content-type"]!.length).toBeLessThanOrEqual(512);
  });
});

describe("NetworkRing", () => {
  it("folds a response onto the request it answers — ONE row, not two", () => {
    const ring = new NetworkRing();
    ring.started({ requestId: "r1", method: "GET", url: "https://x.test/api" });
    ring.finished({
      requestId: "r1",
      status: 500,
      mimeType: "application/json",
    });
    expect(ring.entries()).toHaveLength(1);
    expect(ring.entries()[0]).toMatchObject({
      method: "GET",
      url: "https://x.test/api",
      status: 500,
    });
  });

  it("follows a redirect instead of splitting it into two requests", () => {
    // Each hop fires a fresh request event under the SAME id. Two rows would
    // report two requests, and the row would describe where it started rather
    // than where it ended up.
    const ring = new NetworkRing();
    ring.started({ requestId: "r1", method: "GET", url: "https://x.test/old" });
    ring.started({ requestId: "r1", method: "GET", url: "https://x.test/new" });
    ring.finished({ requestId: "r1", status: 200 });
    expect(ring.entries()).toHaveLength(1);
    expect(ring.entries()[0]!.url).toBe("https://x.test/new");
  });

  it("records a failure, which is a different fact from a status", () => {
    // CORS, DNS, offline, aborted. A request that never got an answer is the
    // most common reason a list renders empty with nothing logged.
    const ring = new NetworkRing();
    ring.started({ requestId: "r1", method: "GET", url: "https://y.test/a" });
    ring.finished({ requestId: "r1", failure: "net::ERR_FAILED" });
    expect(ring.entries()[0]).toMatchObject({ failure: "net::ERR_FAILED" });
    expect(ring.entries()[0]!.status).toBeUndefined();
  });

  it("evicts oldest-first and keeps counting past what it can still show", () => {
    const ring = new NetworkRing(3);
    for (let i = 0; i < 5; i += 1) {
      ring.started({
        requestId: `r${i}`,
        method: "GET",
        url: `https://x.test/${i}`,
      });
    }
    expect(ring.entries().map((r) => r.requestId)).toEqual(["r2", "r3", "r4"]);
    // Monotonic, like the console cursor: the gap between what was captured
    // and what can still be read is real, and hiding it would turn "you can
    // no longer see those" into "there were none".
    expect(ring.count()).toBe(5);
  });

  it("ignores a response to a request it has already evicted", () => {
    // A row with a status and no method describes nothing.
    const ring = new NetworkRing(1);
    ring.started({ requestId: "r1", method: "GET", url: "https://x.test/1" });
    ring.started({ requestId: "r2", method: "GET", url: "https://x.test/2" });
    ring.finished({ requestId: "r1", status: 200 });
    expect(ring.entries()).toHaveLength(1);
    expect(ring.entries()[0]!.requestId).toBe("r2");
  });

  it("DROPS what a person's own session produced, on the handoff purge", () => {
    // The security property. The ring fills from a listener that knows nothing
    // about the lease, so the login POST and the pages someone visited while
    // holding the browser would otherwise be readable by the agent the instant
    // they hand it back. That would make the lease's promise "you must wait to
    // read it" rather than "it is private".
    const ring = new NetworkRing();
    ring.started({
      requestId: "before",
      method: "GET",
      url: "https://x.test/a",
    });
    const handoffAt = Date.now() + 1;
    // Everything from here on happened while a person was driving.
    const later = { ...ring.entries()[0]! };
    ring.started({
      requestId: "during",
      method: "POST",
      url: "https://x.test/login",
    });
    for (const row of ring.entries()) {
      if (row.requestId === "during") row.at = handoffAt + 5;
    }
    ring.dropSince(handoffAt);
    expect(ring.entries().map((r) => r.requestId)).toEqual(["before"]);
    expect(later.requestId).toBe("before");
  });

  it("reads one exchange back by its id", () => {
    const ring = new NetworkRing();
    ring.started({
      requestId: "r7",
      method: "POST",
      url: "https://x.test/pay",
    });
    expect(ring.get("r7")).toMatchObject({ method: "POST" });
    expect(ring.get("nope")).toBeUndefined();
  });
});

describe("capNetwork", () => {
  it("takes the NEWEST within budget and says how many it left", () => {
    // Newest, because a model asking what the network did is asking about the
    // act it just took, and those requests are at the end.
    const rows = Array.from({ length: 5 }, (_, i) => ({
      requestId: `r${i}`,
      method: "GET",
      url: `https://x.test/${i}`,
      at: i,
    }));
    const { entries, omitted } = capNetwork(rows, { maxEntries: 2 });
    expect(entries.map((r) => r.requestId)).toEqual(["r3", "r4"]);
    expect(omitted).toBe(3);
  });
});
