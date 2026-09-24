import { FALLBACK_HINT } from "../../src/oauth/state-machines/shared/dynamic-client-registration.js";
import {
  describeAuthenticatedRequestFailure,
  describeTokenRequestFailure,
  responseFailureFindingKey,
} from "../../src/oauth/state-machines/shared/response-error.js";
import { stepFailureFindingKey } from "../../src/oauth/state-machines/shared/step-failure-key.js";

const tokenFailure = (status: number, statusText: string, body: unknown) =>
  describeTokenRequestFailure({ status, statusText, body } as never);

describe("responseFailureFindingKey", () => {
  // Round-trips through the real writer, so the parser cannot drift from the
  // format it reads.
  it("keeps label, status and the OAuth error code", () => {
    expect(
      responseFailureFindingKey(
        tokenFailure(400, "Bad Request", {
          error: "invalid_grant",
          error_description: "Authorization code not found or expired",
        })
      )
    ).toBe("Token request failed: 400: invalid_grant");
  });

  it("gives one finding one key across servers' wording", () => {
    // PLB-63 and INSPECTOR-CLIENT-2GA: the same `invalid_*` code, phrased and
    // status-texted differently by different servers.
    const a = tokenFailure(400, "Bad Request", {
      error: "invalid_client",
      error_description: "client 3f9a1c27 not found",
    });
    const b = tokenFailure(400, "", {
      error: "invalid_client",
      error_description: "invalid_client_secret",
    });
    const c = tokenFailure(400, "Client Error", { error: "invalid_client" });
    expect(new Set([a, b, c].map(responseFailureFindingKey))).toEqual(
      new Set(["Token request failed: 400: invalid_client"])
    );
  });

  it("keeps different codes apart", () => {
    expect(
      responseFailureFindingKey(
        tokenFailure(400, "", { error: "invalid_grant" })
      )
    ).not.toBe(
      responseFailureFindingKey(
        tokenFailure(400, "", { error: "invalid_client" })
      )
    );
  });

  it("falls back to label and status when the reason opens with no code", () => {
    expect(
      responseFailureFindingKey(
        tokenFailure(503, "Service Unavailable", "<html>upstream down</html>")
      )
    ).toBe("Token request failed: 503");
  });

  it("reads the authenticated-request form too", () => {
    expect(
      responseFailureFindingKey(
        describeAuthenticatedRequestFailure({
          status: 401,
          statusText: "Unauthorized",
          body: {
            error: "invalid_token",
            error_description: "expired at 12:03",
          },
        } as never)
      )
    ).toBe("Authenticated request failed: 401: invalid_token");
  });

  it("is undefined for anything that is not a response failure", () => {
    expect(
      responseFailureFindingKey("Dynamic Client Registration failed (400).")
    ).toBeUndefined();
  });
});

describe("stepFailureFindingKey", () => {
  it("keeps a registration failure together with and without the advisory", () => {
    // Both registration forms: the error ending in a period plus " HINT", and
    // the one without a period plus ". HINT".
    expect(
      stepFailureFindingKey(
        `Dynamic Client Registration failed (401). ${FALLBACK_HINT}`
      )
    ).toBe(stepFailureFindingKey("Dynamic Client Registration failed (401)."));
    expect(
      stepFailureFindingKey(
        `Client registration failed: fetch failed. ${FALLBACK_HINT}`
      )
    ).toBe(stepFailureFindingKey("Client registration failed: fetch failed"));
  });

  it("keeps different registration statuses apart", () => {
    expect(
      stepFailureFindingKey("Dynamic Client Registration failed (400).")
    ).not.toBe(
      stepFailureFindingKey("Dynamic Client Registration failed (401).")
    );
  });

  // Review of #5473: the cause of a discovery failure comes AFTER the first
  // period, so cutting there merged all three into one issue.
  it("keeps discovery failures with different causes apart", () => {
    const prefix =
      "Could not discover authorization server metadata. Last error:";
    const keys = [
      `${prefix} undefined`,
      `${prefix} HTTP 500 from https://auth.example.com/.well-known/oauth-authorization-server`,
      `${prefix} Failed to fetch`,
    ].map(stepFailureFindingKey);
    expect(new Set(keys).size).toBe(3);
  });

  it("keeps one discovery cause together across servers' URLs", () => {
    const prefix =
      "Could not discover authorization server metadata. Last error:";
    expect(
      stepFailureFindingKey(
        `${prefix} HTTP 500 from https://a.example/.well-known/x`
      )
    ).toBe(
      stepFailureFindingKey(`${prefix} HTTP 500 from https://b.example/other`)
    );
  });

  it("replaces ids that would split one finding per request", () => {
    expect(
      stepFailureFindingKey(
        "Failed to request resource metadata: trace 4f2a9c81e7b34d0aa1c2 rejected"
      )
    ).toBe(
      stepFailureFindingKey(
        "Failed to request resource metadata: trace 9b1d77e0c4aa4f2e8830 rejected"
      )
    );
    expect(
      stepFailureFindingKey("x 123e4567-e89b-12d3-a456-426614174000 y")
    ).toBe("x <id> y");
  });

  // Review of #5473: the debug proxy names the host it refused, bare rather
  // than as a URL, so each host a user typed opened its own issue.
  it("keeps one proxy refusal together across hosts", () => {
    const refused = (host: string) =>
      `Failed to request resource metadata: Backend debug proxy error: 400 Bad Request: Could not resolve ${host}`;

    expect(stepFailureFindingKey(refused("tenant-a.example.com"))).toBe(
      stepFailureFindingKey(refused("tenant-b.example.com"))
    );
    expect(stepFailureFindingKey(refused("tenant-a.example.com"))).toBe(
      "Failed to request resource metadata: Backend debug proxy error: 400 Bad Request: Could not resolve <host>"
    );
  });

  it("replaces IP addresses, and keeps the cause inside the cap", () => {
    const privateAddress = (host: string, ip: string) =>
      `Failed to request resource metadata: Backend debug proxy error: 400 Bad Request: ${host} resolves to a private or reserved address (${ip})`;
    const longHost = "mcp-gateway.staging.platform.intranet.corp.example";
    // Long enough that the raw text runs past the cap before the address.
    expect(privateAddress(longHost, "10.0.0.7").length).toBeGreaterThan(160);
    const key = stepFailureFindingKey(privateAddress(longHost, "10.0.0.7"));

    expect(key).toBe(
      stepFailureFindingKey(privateAddress("db.internal.example", "fd00::1"))
    );
    // The address is this message's tail, and it now survives the cap.
    expect(
      key.endsWith("resolves to a private or reserved address (<ip>)")
    ).toBe(true);
  });

  it("finds the host in every form the proxy writes", () => {
    const proxied = (reason: string) =>
      `Failed to request resource metadata: Backend debug proxy error: 400 Bad Request: ${reason}`;
    const same = (a: string, b: string) =>
      expect(stepFailureFindingKey(proxied(a))).toBe(
        stepFailureFindingKey(proxied(b))
      );

    // A label of plain words before the host, and a bare single-label host.
    same(
      "Could not resolve oauth metadata target a.example.com",
      "Could not resolve oauth metadata target intranet"
    );
    expect(
      stepFailureFindingKey(
        proxied("Could not resolve oauth metadata target a.example.com")
      )
    ).toMatch(/Could not resolve oauth metadata target <host>$/);
    same(
      "OAuth metadata target is a private/reserved host (a.corp.example)",
      "OAuth metadata target is a private/reserved host (10.1.2.3)"
    );
    same(
      'Refusing a plaintext connection to "a.example.com": it is a public host, so the target must be served over https.',
      'Refusing a plaintext connection to "b.example.org": it is a public host, so the target must be served over https.'
    );
  });

  // Review of #5473: a global hostname rule also read property paths as hosts,
  // so different MCPJam crashes (Safari and Firefox quote the expression)
  // merged into one issue.
  it("keeps our own crashes apart when they quote a property path", () => {
    const crash = (message: string) =>
      `Failed to request resource metadata: ${message}`;
    const keys = [
      "e.json is not a function",
      "response.headers.get is not a function",
      "undefined is not an object (evaluating 'e.body.issuer')",
      "undefined is not an object (evaluating 'n.headers.get')",
      "e.response is undefined",
      "JSON.parse: unexpected character at line 1 column 1",
    ].map((message) => stepFailureFindingKey(crash(message)));

    expect(new Set(keys).size).toBe(6);
    expect(keys[0]).toBe(crash("e.json is not a function"));
  });

  // Review of #5473: Firefox's network error already ends in a period, so the
  // hinted form has two before the advisory.
  it("keeps a registration network error together with and without the advisory", () => {
    const firefox =
      "Client registration failed: NetworkError when attempting to fetch resource.";
    expect(stepFailureFindingKey(`${firefox}. ${FALLBACK_HINT}`)).toBe(
      stepFailureFindingKey(firefox)
    );
  });

  // CodeQL js/polynomial-redos on #5473: the trailing-period strip was
  // `/\.+$/`, which retries the run from every index when the match fails, so
  // a long run of periods followed by anything else cost O(n^2). The periods
  // must NOT be last — that is the case the regex handles quickly. The server
  // writes `error_description`, so it chooses this text. The regex form takes
  // ~13s here; the timeout is what fails if it comes back.
  it("does not backtrack over a long run of periods", { timeout: 2000 }, () => {
    const padded = `Client registration failed: ${".".repeat(200_000)}x`;
    const key = stepFailureFindingKey(padded);
    expect(key.startsWith("Client registration failed: ..")).toBe(true);
    expect(key).toHaveLength(160);
  });

  // Reported by Sebastián on #5473, present since 7b12239d5. The long-id rule
  // put `(?=[A-Za-z0-9_-]*\d)` ahead of the token; `-` is in the class but is
  // not a `\w`, so `a-a-a-…` sits every letter on a `\b` and the lookahead
  // rescans the rest of the run from each one. Measured on the pattern alone:
  // 200k characters took 21s. A run of plain letters does NOT show it — there
  // is one `\b` in it — which is why the shape here is hyphenated.
  //
  // Deliberately NOT a timing test. With the lookahead restored AND the cap
  // removed this input still cleared the whole pipeline in 130ms, so a
  // duration cannot tell the fixed rule from the broken one here. The cap in
  // `stepFailureFindingKey` has no test either: it only changes a key when
  // the first 4000 characters compress 25-fold, which nothing real does. It
  // is defense in depth against the NEXT pattern, not something observable.
  // What is testable is the rewritten rule's behaviour, so that is what this
  // asserts.
  it("still replaces a long token once a digit is in it", () => {
    expect(stepFailureFindingKey("client abc-def-ghi-jkl-mno rejected")).toBe(
      "client abc-def-ghi-jkl-mno rejected"
    );
    expect(stepFailureFindingKey("client abc-def-ghi-jkl-mn0 rejected")).toBe(
      "client <id> rejected"
    );
  });

  it("does not mistake statuses, codes or versions for hosts", () => {
    const message =
      "Dynamic Client Registration failed (400): invalid_client_metadata: release 3.9.2";
    expect(stepFailureFindingKey(message)).toBe(message);
  });

  it("leaves ordinary words alone", () => {
    // Long, but no digit: not an id.
    expect(
      stepFailureFindingKey(
        "Protected resource metadata is missing authorization_servers."
      )
    ).toBe("Protected resource metadata is missing authorization_servers");
  });

  it("caps the key's length", () => {
    expect(
      stepFailureFindingKey(`Boom: ${"word ".repeat(200)}`).length
    ).toBeLessThanOrEqual(160);
  });

  it("reduces a token failure through the response rule", () => {
    expect(
      stepFailureFindingKey(
        tokenFailure(400, "Bad Request", {
          error: "invalid_grant",
          error_description: "nope",
        })
      )
    ).toBe("Token request failed: 400: invalid_grant");
  });
});
