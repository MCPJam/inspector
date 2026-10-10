import { describe, expect, it } from "vitest";
import {
  containsCredential,
  CREDENTIAL_PLACEHOLDER,
  CREDENTIAL_ROUTES,
  credentialRouteTemplate,
  isReplayBlockedLocation,
  isReplayBlockedUrl,
  isSecretParamKey,
  matchCredentialPath,
  scrubCredentialsInText,
  scrubCredentialUrl,
  scrubTelemetryEvent,
  scrubTelemetryValue,
  TelemetryScrubError,
} from "../credential-urls";

/**
 * The corpus: one URL per credential shape, each carrying a unique sentinel
 * where the secret goes. Every scrubber must remove every sentinel and keep
 * the rest of the URL readable. A new registry entry without a corpus line
 * fails the "every route has a corpus entry" test below.
 */
const SENTINEL = "SENTINELx9q7";
const sentinel = (id: string) => `${SENTINEL}${id.replace(/[^a-z]/gi, "")}`;

const CORPUS: Record<string, string> = {
  "score-results": `https://app.mcpjam.com/results/${sentinel("score")}`,
  "bench-results": `https://score.mcpjam.com/bench/results/${sentinel("bench")}`,
  "conformance-shared": `/conformance/shared/${sentinel("conf")}`,
  "evals-shared": `/evals/shared/${sentinel("evals")}?tab=summary`,
  "tester-link": `/user-testing/acme-study/${sentinel("tester")}`,
  "tester-link-legacy": `/chatbox/acme-study/${sentinel("chatbox")}`,
  "server-connection-claim": `/connect/server/${sentinel("handoff")}`,
  "mcp-oauth-callback": `/oauth/callback?code=${sentinel("code")}&state=${sentinel("state")}`,
  "github-install-callback": `/settings/integrations/github/callback?code=${sentinel("gh")}&installation_id=42`,
  "workos-callback": `/callback?code=${sentinel("workos")}`,
  "local-access-link": `/#token=${sentinel("access")}&tab=servers`,
  "api-score-run": `/api/web/score/runs/${sentinel("apiscore")}`,
  "api-bench-results": `/api/web/bench/results/${sentinel("apibench")}`,
  "api-conformance-shared": `/api/web/conformance-shared/${sentinel("apiconf")}`,
  "api-session-token-query": `/api/mcp/servers/rpc/stream?serverId=a&_token=${sentinel("session")}`,
  "signed-artifact-link": `https://rt-http.mcpjam.com/artifact?t=${sentinel("artifact")}`,
};

/** Shapes the registry handles generically, beyond the routes. */
const GENERIC_CORPUS = [
  `https://user:${sentinel("pass")}@example.com/path`,
  `https://bucket.s3.amazonaws.com/o?X-Amz-Signature=${sentinel("amz")}&X-Amz-Credential=${sentinel("amzc")}`,
  `https://idp.example.com/sso?SAMLResponse=${sentinel("saml")}&RelayState=${sentinel("relay")}`,
  `https://provider.example.com/token?client_secret=${sentinel("cs")}&refresh_token=${sentinel("rt")}`,
  `mcpjam://oauth/callback?code=${sentinel("electron")}`,
  `/oauth/callback/debug#access_token=${sentinel("implicit")}`,
  `/#/results/${sentinel("hashroute")}`,
  `/p/proj/servers?redirect=${encodeURIComponent(`https://app.mcpjam.com/results/${sentinel("nested")}?code=${sentinel("nestedcode")}`)}`,
];

describe("the corpus", () => {
  it("has an entry for every registered route", () => {
    expect(Object.keys(CORPUS).sort()).toEqual(
      CREDENTIAL_ROUTES.map((route) => route.id).sort(),
    );
  });

  it.each(Object.entries(CORPUS))(
    "%s: the URL scrubber removes the secret",
    (_id, url) => {
      expect(url).toContain(SENTINEL);
      const scrubbed = scrubCredentialUrl(url);
      expect(scrubbed).not.toContain(SENTINEL);
      expect(scrubbed).toContain(CREDENTIAL_PLACEHOLDER);
    },
  );

  it.each(Object.entries(CORPUS))(
    "%s: the text scrubber removes it inside prose",
    (_id, url) => {
      const prose = `Opened ${url}, then left.`;
      const scrubbed = scrubCredentialsInText(prose);
      expect(scrubbed).not.toContain(SENTINEL);
      expect(scrubbed.startsWith("Opened ")).toBe(true);
      expect(scrubbed.endsWith(", then left.")).toBe(true);
    },
  );

  it.each(GENERIC_CORPUS)("generic shape %s is scrubbed", (url) => {
    expect(scrubCredentialUrl(url)).not.toContain(SENTINEL);
    expect(scrubCredentialsInText(`see ${url} now`)).not.toContain(SENTINEL);
  });

  it.each(
    Object.entries(CORPUS).filter(([id]) => {
      const route = CREDENTIAL_ROUTES.find((entry) => entry.id === id);
      return route?.scope === "page";
    }),
  )("%s: replay is blocked on the page", (_id, url) => {
    expect(isReplayBlockedUrl(url)).toBe(true);
  });

  it("nothing scrubs twice: a scrubbed URL is a fixed point", () => {
    for (const url of [...Object.values(CORPUS), ...GENERIC_CORPUS]) {
      const once = scrubCredentialUrl(url);
      expect(scrubCredentialUrl(once)).toBe(once);
      const text = scrubCredentialsInText(`x ${url} y`);
      expect(scrubCredentialsInText(text)).toBe(text);
    }
  });
});

describe("scrubCredentialUrl", () => {
  it("keeps everything that is not a secret, as written", () => {
    expect(
      scrubCredentialUrl("https://app.mcpjam.com/results/abc?x=1&y=two#frag"),
    ).toBe("https://app.mcpjam.com/results/[redacted]?x=1&y=two#frag");
    expect(scrubCredentialUrl("/bench/results/deadbeef/")).toBe(
      "/bench/results/[redacted]/",
    );
    expect(
      scrubCredentialUrl(
        "/oauth/callback?code=c&state=s&iss=https%3A%2F%2Fissuer.example",
      ),
    ).toBe(
      "/oauth/callback?code=[redacted]&state=[redacted]&iss=https%3A%2F%2Fissuer.example",
    );
  });

  it("returns a URL without credentials unchanged, byte for byte", () => {
    for (const url of [
      "/p/k17abc/servers?tab=tools",
      "https://app.mcpjam.com/settings/api-keys",
      "/user-testing/k123abc/edit",
      "/connect/server/request/req_123",
      "/results",
      "/evals/shared",
      "https://example.com/a%20b?q=%E2%9C%93",
      "",
    ]) {
      expect(scrubCredentialUrl(url)).toBe(url);
    }
  });

  it("does not mistake app vocabulary for a secret", () => {
    expect(matchCredentialPath("/user-testing/scn_1/edit")).toBeNull();
    expect(matchCredentialPath("/user-testing/scn_1")).toBeNull();
    expect(matchCredentialPath("/connect/server/request")).toBeNull();
    expect(matchCredentialPath("/connect/server/request/r1")).toBeNull();
    expect(matchCredentialPath("/p/proj/evals/shared/x")).toBeNull();
  });

  it("drops userinfo", () => {
    expect(scrubCredentialUrl("https://u:p@host.example/x")).toBe(
      "https://host.example/x",
    );
  });

  it("runs before name scrubbing could keep a hex secret as an 'id'", () => {
    // `scrubNamesFromUrl` keeps id-like segments; a bench secret is one.
    expect(scrubCredentialUrl("/bench/results/0123456789abcdef0123")).toBe(
      "/bench/results/[redacted]",
    );
  });

  it("never throws, whatever it is given", () => {
    for (const value of [
      "%",
      "/results/%E0%A4%A",
      "http://[::1",
      "?code",
      "#",
      "://",
      "\u0000/results/x",
      undefined as unknown as string,
      42 as unknown as string,
    ]) {
      expect(() => scrubCredentialUrl(value)).not.toThrow();
    }
  });
});

describe("scrubCredentialsInText", () => {
  it("keeps sentence punctuation outside the URL", () => {
    expect(
      scrubCredentialsInText("Redirected to https://x.example/cb?code=abc."),
    ).toBe("Redirected to https://x.example/cb?code=[redacted].");
  });

  it("finds percent-encoded URLs nested in another URL", () => {
    const nested = `redirect=${encodeURIComponent("https://app.mcpjam.com/results/tok?code=c1")}`;
    const out = scrubCredentialsInText(nested);
    expect(out).not.toContain("tok");
    expect(out).not.toContain("c1");
  });

  it("scrubs a form body", () => {
    expect(
      scrubCredentialsInText(
        "code=abc&state=def&grant_type=authorization_code",
      ),
    ).toBe("code=[redacted]&state=[redacted]&grant_type=authorization_code");
  });

  it("leaves prose that only mentions a key alone", () => {
    for (const text of [
      "the state machine is ready",
      "set state=ok in the config",
      "error code 401",
      "GET /api/web/projects 200",
    ]) {
      expect(scrubCredentialsInText(text)).toBe(text);
    }
  });

  it("reports whether anything was found", () => {
    expect(containsCredential("x /results/abc y")).toBe(true);
    expect(containsCredential("x /results/[redacted] y")).toBe(false);
  });
});

describe("isSecretParamKey", () => {
  it("knows the registered keys, case-insensitively", () => {
    for (const key of [
      "code",
      "STATE",
      "_token",
      "t",
      "k",
      "client_secret",
      "X-Amz-Signature",
      "x-goog-credential",
      "SAMLResponse",
      "RelayState",
      "ticket",
      "x_vendor_access_token",
    ]) {
      expect(isSecretParamKey(key)).toBe(true);
    }
  });

  it("leaves ordinary keys alone", () => {
    for (const key of ["tab", "q", "session", "projectId", "installation_id"]) {
      expect(isSecretParamKey(key)).toBe(false);
    }
  });
});

describe("isReplayBlockedLocation", () => {
  it("blocks credential paths, callbacks and secret keys anywhere", () => {
    expect(isReplayBlockedLocation({ pathname: "/results/abc" })).toBe(true);
    expect(isReplayBlockedLocation({ pathname: "/oauth/callback" })).toBe(true);
    expect(isReplayBlockedLocation({ pathname: "/oauth/callback/debug" })).toBe(
      true,
    );
    expect(
      isReplayBlockedLocation({
        pathname: "/settings/integrations/github/callback",
      }),
    ).toBe(true);
    expect(
      isReplayBlockedLocation({ pathname: "/servers", search: "?code=x" }),
    ).toBe(true);
    expect(isReplayBlockedLocation({ pathname: "/", hash: "#token=abc" })).toBe(
      true,
    );
  });

  it("records ordinary pages", () => {
    expect(
      isReplayBlockedLocation({ pathname: "/p/x/servers", search: "?tab=a" }),
    ).toBe(false);
    expect(isReplayBlockedLocation({ pathname: "/user-testing/s/edit" })).toBe(
      false,
    );
    expect(isReplayBlockedLocation({ pathname: "/", hash: "#section" })).toBe(
      false,
    );
  });
});

describe("credentialRouteTemplate", () => {
  it("names the template, never the secret", () => {
    expect(credentialRouteTemplate("/results/abc")).toBe("/results/:runToken");
    expect(credentialRouteTemplate("/api/web/bench/results/ff")).toBe(
      "/api/web/bench/results/:secret",
    );
    expect(credentialRouteTemplate("/p/x/servers")).toBeNull();
  });
});

describe("scrubTelemetryValue", () => {
  it("scrubs every string and every key, at any depth", () => {
    const value = {
      token: "phc_project_key",
      properties: {
        $current_url: `https://app.mcpjam.com/results/${SENTINEL}`,
        $set: { last_url: `/bench/results/${SENTINEL}` },
        list: [{ deep: [`/oauth/callback?code=${SENTINEL}`] }],
        $$heatmap: { [`https://app.mcpjam.com/results/${SENTINEL}`]: [1] },
        count: 3,
        ok: true,
        nothing: null,
      },
    };
    const out = scrubTelemetryValue(value, { preserveTopLevelKeys: ["token"] });
    expect(JSON.stringify(out)).not.toContain(SENTINEL);
    expect(out.token).toBe("phc_project_key");
    expect(out.properties.count).toBe(3);
    expect(out.properties.ok).toBe(true);
    expect(out.properties.nothing).toBeNull();
    // The input is not mutated.
    expect(value.properties.$current_url).toContain(SENTINEL);
  });

  it("refuses what it cannot finish", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => scrubTelemetryValue(cyclic)).toThrow(TelemetryScrubError);

    let deep: unknown = "x";
    for (let i = 0; i < 100; i++) deep = { d: deep };
    expect(() => scrubTelemetryValue(deep)).toThrow(TelemetryScrubError);
  });
});

describe("scrubTelemetryEvent (fail closed)", () => {
  it("strips the URL-bearing fields when the walker cannot finish", () => {
    let deep: unknown = `/results/${SENTINEL}`;
    for (let i = 0; i < 100; i++) deep = { d: deep };
    const reasons: string[] = [];
    const out = scrubTelemetryEvent(
      {
        event: "$pageview",
        properties: {
          $current_url: `/results/${SENTINEL}`,
          $exception_list: deep,
          plain: "kept",
        },
      },
      { onFallback: (reason) => reasons.push(reason) },
    );
    expect(out).not.toBeNull();
    expect(JSON.stringify(out)).not.toContain(SENTINEL);
    expect(out?.properties).toEqual({ plain: "kept" });
    expect(reasons).toHaveLength(1);
  });

  it("drops the event when even that fails", () => {
    let deep: unknown = "x";
    for (let i = 0; i < 100; i++) deep = { d: deep };
    expect(
      scrubTelemetryEvent({ event: "x", properties: { deep } }),
    ).toBeNull();
  });
});

describe("route templates", () => {
  it("are never mistaken for a secret", () => {
    for (const route of CREDENTIAL_ROUTES) {
      const template = route.pattern.replace(/\*$/, "");
      expect(scrubCredentialUrl(template)).toBe(template);
      expect(scrubCredentialsInText(`GET ${template}`)).toBe(`GET ${template}`);
    }
  });
});
