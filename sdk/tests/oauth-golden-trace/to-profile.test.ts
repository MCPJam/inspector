/**
 * HP-44 — the trace → `HostConfigOAuthProfileV1` projection.
 *
 * These tests are mostly about RESTRAINT. A trace is the strongest evidence we
 * have, and the temptation is to let it settle every field. It cannot, and the
 * places where it cannot are exactly where the previous rounds of this work went
 * wrong. Each test below pins one of those limits so a later change cannot
 * quietly relax it.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalizeOAuthProfile } from "../../src/host-config/internal.js";
import type { HostConfigOAuthProfileV1 } from "../../src/host-config/types.js";
import {
  deriveObservations,
  mergeTraceOAuthProfile,
  traceToOAuthProfile,
} from "../../src/oauth-golden-trace/index.js";
import type { GoldenTrace } from "../../src/oauth-golden-trace/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(
  HERE,
  "..",
  "fixtures",
  "golden-traces",
  "mcpjam-in-memory-dcr-authcode-prm.json",
);

function loadTrace(): GoldenTrace {
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as GoldenTrace;
}

/** Rebuild observations after editing a wire, keeping the trace consistent. */
function reobserve(trace: GoldenTrace): GoldenTrace {
  return {
    ...trace,
    observations: deriveObservations({
      wire: trace.wire,
      scenario: trace.scenario,
    }),
  };
}

describe("traceToOAuthProfile", () => {
  it("produces a profile the host-config canonicalizer accepts", () => {
    // The point of projecting onto the existing type rather than inventing a
    // parallel vocabulary: the output has to survive the real canonicalizer.
    const profile = traceToOAuthProfile(loadTrace(), {
      tracePath: "sdk/tests/fixtures/golden-traces/mcpjam-in-memory-dcr-authcode-prm.json",
    });
    expect(() => canonicalizeOAuthProfile(profile)).not.toThrow();
  });

  it("verifies sendsResourceIndicator with the trace as the source", () => {
    const profile = traceToOAuthProfile(loadTrace(), { tracePath: "traces/x.json" });
    const evidence = profile.sendsResourceIndicator;

    expect(evidence?.status).toBe("verified");
    if (evidence?.status === "verified" || evidence?.status === "refuted") {
      expect(evidence.value).toBe(true);
      // A trace is E2 evidence and cites itself, so a reviewer can open it.
      expect(evidence.source).toContain("E2");
      expect(evidence.source).toContain("traces/x.json");
      expect(evidence.capturedAt).toBe("2026-07-29");
    }
  });

  it("refuses to call `resource` absent when the server published no PRM", () => {
    // VS Code and Cline both omit `resource` entirely when PRM discovery fails,
    // and that is CORRECT. Recording `false` from a no-PRM capture would
    // manufacture a finding about the client out of a property of the server.
    const trace = loadTrace();
    const noPrm = reobserve({
      ...trace,
      scenario: {
        ...trace.scenario,
        capabilities: {
          ...trace.scenario.capabilities,
          publishesPrm: false,
          prmResource: undefined,
        },
      },
      wire: trace.wire.map((exchange) => {
        const next = JSON.parse(JSON.stringify(exchange)) as typeof exchange;
        if (next.request.query?.resource) delete next.request.query.resource;
        if (next.request.body?.encoding === "form") {
          delete next.request.body.fields.resource;
        }
        return next;
      }),
    });

    const evidence = traceToOAuthProfile(noPrm).sendsResourceIndicator;
    expect(evidence?.status).toBe("unverifiable");
    if (evidence?.status === "unverifiable") {
      expect(evidence.reason).toContain("publishes no RFC 9728 PRM document");
    }
  });

  it("verifies `resource: false` when a PRM-publishing server was still ignored", () => {
    const trace = loadTrace();
    const stripped = reobserve({
      ...trace,
      wire: trace.wire.map((exchange) => {
        const next = JSON.parse(JSON.stringify(exchange)) as typeof exchange;
        if (next.request.query?.resource) delete next.request.query.resource;
        if (next.request.body?.encoding === "form") {
          delete next.request.body.fields.resource;
        }
        return next;
      }),
    });

    const evidence = traceToOAuthProfile(stripped).sendsResourceIndicator;
    expect(evidence?.status).toBe("verified");
    if (evidence?.status === "verified") expect(evidence.value).toBe(false);
  });

  it("keeps a HALF-observed handshake unverifiable instead of claiming `false`", () => {
    // The trap: `/authorize` never captured, `/token` captured without
    // `resource`. Requiring only that SOME leg was observed would emit
    // `verified: false` citing "both legs were captured", which is untrue — the
    // unwatched leg could have carried it. `absent` is a finding, `not-observed`
    // is a gap, and this is the boundary between them.
    const trace = loadTrace();
    const tokenOnly = reobserve({
      ...trace,
      wire: trace.wire
        .filter((exchange) => exchange.leg !== "authorize")
        .map((exchange) => {
          const next = JSON.parse(JSON.stringify(exchange)) as typeof exchange;
          if (next.request.query?.resource) delete next.request.query.resource;
          if (next.request.body?.encoding === "form") {
            delete next.request.body.fields.resource;
          }
          return next;
        }),
    });

    const evidence = traceToOAuthProfile(tokenOnly).sendsResourceIndicator;
    expect(evidence?.status).toBe("unverifiable");
    if (evidence?.status === "unverifiable") {
      expect(evidence.reason).toContain("/authorize");
      expect(evidence.reason).toContain("half-observed pair cannot justify");
    }
  });

  it("still verifies `resource: true` from a single captured leg", () => {
    // The other side of the same boundary: one leg carrying `resource` is a
    // positive observation, and an unwatched second leg cannot unmake it.
    const trace = loadTrace();
    const tokenOnly = reobserve({
      ...trace,
      wire: trace.wire.filter((exchange) => exchange.leg !== "authorize"),
    });

    const evidence = traceToOAuthProfile(tokenOnly).sendsResourceIndicator;
    expect(evidence?.status).toBe("verified");
    if (evidence?.status === "verified") {
      expect(evidence.value).toBe(true);
      expect(evidence.source).toContain("/token");
    }
  });

  it("verifies protocolVersionPinning ONLY from the OAuth-discovery header", () => {
    // The single arm one trace can prove: at discovery time no `initialize` has
    // happened, so the header cannot be a negotiated value — it is a client-chosen
    // constant. This is how `rmcp`'s hardcoded 2024-11-05 becomes provable.
    const profile = traceToOAuthProfile(loadTrace());
    const evidence = profile.protocolVersionPinning;

    expect(evidence?.status).toBe("verified");
    if (evidence?.status === "verified") {
      expect(evidence.value).toEqual({ mode: "pinned", version: "2025-11-25" });
      expect(evidence.source).toContain("BEFORE any `initialize` exchange");
      // Scope is stated explicitly so nobody reads this as a claim about the MCP wire.
      expect(evidence.source).toContain("the OAuth wire only");
    }
  });

  it("leaves protocolVersionPinning unverifiable with no OAuth-discovery header", () => {
    // Without that header a single capture cannot tell a pin from a negotiation:
    // a client that negotiates emits the same byte as one that pins when it is
    // talking to exactly one server. This is the trap that produced wrong answers
    // for SDK-delegated clients.
    const trace = loadTrace();
    const noHeader = reobserve({
      ...trace,
      wire: trace.wire.map((exchange) => {
        const next = JSON.parse(JSON.stringify(exchange)) as typeof exchange;
        delete next.request.headers["mcp-protocol-version"];
        return next;
      }),
    });

    const evidence = traceToOAuthProfile(noHeader).protocolVersionPinning;
    expect(evidence?.status).toBe("unverifiable");
    if (evidence?.status === "unverifiable") {
      expect(evidence.reason).toContain("cannot distinguish a pin from a negotiation");
      // The reason names the experiment that WOULD settle it.
      expect(evidence.reason).toContain("second server advertising a DIFFERENT");
    }
  });

  it("settles pin-vs-negotiate from a contrast trace", () => {
    const trace = loadTrace();
    const noHeader = reobserve({
      ...trace,
      wire: trace.wire.map((exchange) => {
        const next = JSON.parse(JSON.stringify(exchange)) as typeof exchange;
        delete next.request.headers["mcp-protocol-version"];
        return next;
      }),
    });

    // Same client, second server, and — the load-bearing part — a server that
    // ADVERTISED a different protocol version, recorded on the scenario. Same
    // value in the initialize body across both ⇒ the value does not follow the
    // server ⇒ a real pin. Comparing `noHeader` against itself, or against a
    // same-version server, would produce this verdict for free, which is why all
    // three conditions are checked.
    const sameValueElsewhere = reobserve({
      ...noHeader,
      traceId: "mcpjam/other-scenario/2026-07-29/emulator",
      scenario: {
        ...noHeader.scenario,
        scenarioId: "other-scenario",
        capabilities: {
          ...noHeader.scenario.capabilities,
          serverProtocolVersion: "2025-06-18",
        },
      },
    });
    const pinned = traceToOAuthProfile(noHeader, {
      contrastTrace: sameValueElsewhere,
    });
    expect(pinned.protocolVersionPinning?.status).toBe("verified");
    if (pinned.protocolVersionPinning?.status === "verified") {
      expect(pinned.protocolVersionPinning.value).toEqual({
        mode: "pinned",
        version: "2025-11-25",
      });
      // The citation names both sides AND the two advertised versions, so a
      // reviewer can check the experiment without opening the artifacts.
      expect(pinned.protocolVersionPinning.source).toContain(
        "scenario `in-memory-dcr-authcode-prm-mcp2025-11-25`",
      );
      expect(pinned.protocolVersionPinning.source).toContain("scenario `other-scenario`");
      expect(pinned.protocolVersionPinning.source).toContain("server advertised `2025-11-25`");
      expect(pinned.protocolVersionPinning.source).toContain("server advertised `2025-06-18`");
    }

    // A different value against the second server ⇒ it follows the server.
    const contrast = reobserve({
      ...noHeader,
      traceId: "mcpjam/other-scenario/2026-07-29/emulator",
      scenario: {
        ...noHeader.scenario,
        scenarioId: "other-scenario",
        capabilities: {
          ...noHeader.scenario.capabilities,
          serverProtocolVersion: "2025-06-18",
        },
      },
      wire: noHeader.wire.map((exchange) => {
        const next = JSON.parse(JSON.stringify(exchange)) as typeof exchange;
        if (
          next.request.body?.encoding === "jsonrpc" &&
          next.request.body.json &&
          typeof next.request.body.json === "object"
        ) {
          const json = next.request.body.json as {
            params?: { protocolVersion?: string };
          };
          if (json.params?.protocolVersion) json.params.protocolVersion = "2025-06-18";
        }
        return next;
      }),
    });

    const negotiated = traceToOAuthProfile(noHeader, { contrastTrace: contrast });
    expect(negotiated.protocolVersionPinning?.status).toBe("verified");
    if (negotiated.protocolVersionPinning?.status === "verified") {
      expect(negotiated.protocolVersionPinning.value).toEqual({ mode: "negotiated" });
    }
  });

  it("rejects a contrast trace that is not the two-server experiment", () => {
    // The strongest claim in this module used to rest on a caller promise: hand
    // `contrastTrace` the same capture (or an unrelated host's) and an identical
    // value became a `verified` pin out of nothing.
    const trace = loadTrace();
    const noHeader = reobserve({
      ...trace,
      wire: trace.wire.map((exchange) => {
        const next = JSON.parse(JSON.stringify(exchange)) as typeof exchange;
        delete next.request.headers["mcp-protocol-version"];
        return next;
      }),
    });

    const itself = traceToOAuthProfile(noHeader, { contrastTrace: noHeader })
      .protocolVersionPinning;
    expect(itself?.status).toBe("unverifiable");
    if (itself?.status === "unverifiable") {
      expect(itself.reason).toContain("ran the SAME scenario");
    }

    // A second scenario against a genuinely different-version server, but a
    // different CLIENT — a shared value across two clients says nothing about
    // either one's pinning. The version differs so this can only fail on identity.
    const otherHost = reobserve({
      ...noHeader,
      traceId: "vscode/other-scenario/2026-07-29/real-host",
      subject: { ...noHeader.subject, hostId: "vscode" },
      scenario: {
        ...noHeader.scenario,
        scenarioId: "other-scenario",
        capabilities: {
          ...noHeader.scenario.capabilities,
          serverProtocolVersion: "2025-06-18",
        },
      },
    });
    const crossHost = traceToOAuthProfile(noHeader, { contrastTrace: otherHost })
      .protocolVersionPinning;
    expect(crossHost?.status).toBe("unverifiable");
    if (crossHost?.status === "unverifiable") {
      expect(crossHost.reason).toContain("different subject");
    }
  });

  it("rejects a contrast trace whose server advertised the SAME version", () => {
    // The failure the scenario-id check alone could not see. Two distinct scenario
    // ids can still both be servers advertising `2025-11-25`, and against two
    // same-version servers a NEGOTIATING client emits the same value a pinning one
    // does — so reading a match as a pin inverts the answer.
    const trace = loadTrace();
    const noHeader = reobserve({
      ...trace,
      wire: trace.wire.map((exchange) => {
        const next = JSON.parse(JSON.stringify(exchange)) as typeof exchange;
        delete next.request.headers["mcp-protocol-version"];
        return next;
      }),
    });

    const sameVersionServer = reobserve({
      ...noHeader,
      traceId: "mcpjam/other-scenario/2026-07-29/emulator",
      scenario: { ...noHeader.scenario, scenarioId: "other-scenario" },
    });
    const evidence = traceToOAuthProfile(noHeader, {
      contrastTrace: sameVersionServer,
    }).protocolVersionPinning;
    expect(evidence?.status).toBe("unverifiable");
    if (evidence?.status === "unverifiable") {
      expect(evidence.reason).toContain("SAME protocol version");
      expect(evidence.reason).toContain("2025-11-25");
    }
  });

  it("rejects a contrast trace whose advertised version is unrecorded", () => {
    // "Not recorded" is a gap, not a licence to assume the servers differed — the
    // same not-observed-vs-absent distinction the whole module is built on.
    const trace = loadTrace();
    const noHeader = reobserve({
      ...trace,
      wire: trace.wire.map((exchange) => {
        const next = JSON.parse(JSON.stringify(exchange)) as typeof exchange;
        delete next.request.headers["mcp-protocol-version"];
        return next;
      }),
    });

    const capabilities = { ...noHeader.scenario.capabilities };
    delete capabilities.serverProtocolVersion;
    const unrecorded = reobserve({
      ...noHeader,
      traceId: "mcpjam/other-scenario/2026-07-29/emulator",
      scenario: { ...noHeader.scenario, scenarioId: "other-scenario", capabilities },
    });
    const evidence = traceToOAuthProfile(noHeader, { contrastTrace: unrecorded })
      .protocolVersionPinning;
    expect(evidence?.status).toBe("unverifiable");
    if (evidence?.status === "unverifiable") {
      expect(evidence.reason).toContain("serverProtocolVersion");
      expect(evidence.reason).toContain("cannot be shown that the two servers differed");
    }
  });

  it("rejects a contrast trace whose client code cannot be shown to match", () => {
    // `hostId`/`kind`/`build`/`surface` can all agree while the OAuth code behind
    // them is different — a version bump, or a dependency bump for a client that
    // delegates. Pinning is a property of THAT code, so identity alone (the
    // fields checked before this regression) is not enough: a same-hostId trace
    // from a different `hostVersion`, or one missing the stamp entirely, must be
    // rejected exactly like a different host would be.
    const trace = loadTrace();
    const noHeader = reobserve({
      ...trace,
      wire: trace.wire.map((exchange) => {
        const next = JSON.parse(JSON.stringify(exchange)) as typeof exchange;
        delete next.request.headers["mcp-protocol-version"];
        return next;
      }),
    });
    const differentVersionScenario = {
      ...noHeader.scenario,
      scenarioId: "other-scenario",
      capabilities: {
        ...noHeader.scenario.capabilities,
        serverProtocolVersion: "2025-06-18",
      },
    };

    // Same hostId, different hostVersion.
    const upgraded = reobserve({
      ...noHeader,
      traceId: "mcpjam/other-scenario/2026-07-29/emulator",
      subject: {
        ...noHeader.subject,
        hostVersion: { state: "present", value: "9.9.9" },
      },
      scenario: differentVersionScenario,
    });
    const versionMismatch = traceToOAuthProfile(noHeader, { contrastTrace: upgraded })
      .protocolVersionPinning;
    expect(versionMismatch?.status).toBe("unverifiable");
    if (versionMismatch?.status === "unverifiable") {
      expect(versionMismatch.reason).toContain("different `hostVersion`s");
    }

    // Same hostId, hostVersion not stamped on the contrast.
    const unstamped = reobserve({
      ...noHeader,
      traceId: "mcpjam/other-scenario/2026-07-29/emulator",
      subject: {
        ...noHeader.subject,
        hostVersion: { state: "not-observed", reason: "not captured" },
      },
      scenario: differentVersionScenario,
    });
    const versionUnknown = traceToOAuthProfile(noHeader, { contrastTrace: unstamped })
      .protocolVersionPinning;
    expect(versionUnknown?.status).toBe("unverifiable");
    if (versionUnknown?.status === "unverifiable") {
      expect(versionUnknown.reason).toContain("does not record `subject.hostVersion`");
    }

    // Same hostId and hostVersion, oauthImplementation not stamped.
    const noImplementation = reobserve({
      ...noHeader,
      traceId: "mcpjam/other-scenario/2026-07-29/emulator",
      subject: {
        ...noHeader.subject,
        oauthImplementation: { state: "not-observed", reason: "not captured" },
      },
      scenario: differentVersionScenario,
    });
    const implementationUnknown = traceToOAuthProfile(noHeader, {
      contrastTrace: noImplementation,
    }).protocolVersionPinning;
    expect(implementationUnknown?.status).toBe("unverifiable");
    if (implementationUnknown?.status === "unverifiable") {
      expect(implementationUnknown.reason).toContain(
        "does not record `subject.oauthImplementation`",
      );
    }
  });

  it("routes the missing-initialize-body blocker to the right fix", () => {
    // The experiment can be VALID (same client, genuinely different server
    // versions) and still unable to answer, because one side's `initialize` body
    // was never captured. That is a re-capture problem, not a "supply a
    // contrastTrace" problem, and the fallback used to say the latter regardless.
    const trace = loadTrace();
    const noHeader = reobserve({
      ...trace,
      wire: trace.wire.map((exchange) => {
        const next = JSON.parse(JSON.stringify(exchange)) as typeof exchange;
        delete next.request.headers["mcp-protocol-version"];
        return next;
      }),
    });

    const contrastMissingInitialize = reobserve({
      ...noHeader,
      traceId: "mcpjam/other-scenario/2026-07-29/emulator",
      scenario: {
        ...noHeader.scenario,
        scenarioId: "other-scenario",
        capabilities: {
          ...noHeader.scenario.capabilities,
          serverProtocolVersion: "2025-06-18",
        },
      },
      // Drop every JSON-RPC `initialize` exchange, not just the `mcp-initialize`
      // leg: the fixture ALSO sends `initialize` on the earlier unauthenticated
      // attempt, and `observeInitializeBodyVersion` reads whichever occurrence it
      // finds first regardless of leg — so filtering by leg name alone leaves
      // the body observable via the other occurrence and the test proves nothing.
      wire: noHeader.wire.filter(
        (exchange) => exchange.request.body?.encoding !== "jsonrpc",
      ),
    });

    const evidence = traceToOAuthProfile(noHeader, {
      contrastTrace: contrastMissingInitialize,
    }).protocolVersionPinning;
    expect(evidence?.status).toBe("unverifiable");
    if (evidence?.status === "unverifiable") {
      // Must NOT say "only one capture is available" — a valid second capture
      // was supplied. Must name the real blocker instead.
      expect(evidence.reason).not.toContain("only one capture is available");
      expect(evidence.reason).toContain("A valid contrast trace was supplied");
      expect(evidence.reason).toContain("mcp-initialize");
    }
  });

  it("records oauthSpecVersion as a behavioral FLOOR, never an exact revision", () => {
    // A trace observes wire shape. A literal revision string is a claim about the
    // client's code or its docs, so `basis: "constant"` is not something a capture
    // can ever justify.
    const evidence = traceToOAuthProfile(loadTrace()).oauthSpecVersion;
    expect(evidence?.status).toBe("verified");
    if (evidence?.status === "verified") {
      expect(evidence.value.basis).toBe("behavioral");
      if (evidence.value.basis === "behavioral") {
        expect(evidence.value.minimumRevision).toBe("2025-06-18");
      }
      expect(evidence.source).toContain("FLOOR");
    }
  });

  it("never settles authModel from a trace", () => {
    // The field means "every model the client supports, in preference order". A
    // trace shows the ONE path taken against ONE server's capabilities.
    const evidence = traceToOAuthProfile(loadTrace()).authModel;
    expect(evidence?.status).toBe("unverifiable");
    if (evidence?.status === "unverifiable") {
      expect(evidence.reason).toContain("cannot enumerate what else it supports");
    }
    // The `unverifiable` arm carries no value at all — unverified lore is
    // unrepresentable, not merely discouraged.
    expect("value" in (evidence ?? {})).toBe(false);
  });

  it("verifies dcrIdentity and flags the User-Agent expressiveness gap", () => {
    const evidence = traceToOAuthProfile(loadTrace()).dcrIdentity;
    expect(evidence?.status).toBe("verified");
    if (evidence?.status === "verified") {
      expect(evidence.value.clientName).toBe("MCPJam SDK OAuth Conformance");
      expect(evidence.value.redirectUris).toEqual([
        "http://127.0.0.1:{port}/callback",
      ]);
      // MCPJam's OAuth runs in a browser, which forbids scripts from setting
      // User-Agent — so there is nothing to record, and the target type has no way
      // to distinguish that from "we didn't look". The caveat says so out loud.
      expect(evidence.value.userAgent).toBeUndefined();
      expect(evidence.source).toContain("no single `User-Agent`");
      expect(evidence.source).toContain("`{port}`");
    }
  });

  it("preserves every observation the target type cannot express", () => {
    // A schema gap must never cost a finding.
    const extensions = traceToOAuthProfile(loadTrace()).extensions as Record<
      string,
      unknown
    >;

    expect(Object.keys(extensions).sort()).toEqual([
      "tracePkce",
      "traceAuthPath",
      "traceDcrIdentity",
      "traceProtocolVersion",
      "traceProvenance",
      "traceResourceIndicator",
      "traceUserAgent",
    ].sort());

    // The two-headed protocol-version finding survives whole, even though
    // `protocolVersionPinning` could only carry one arm of it.
    const pv = extensions.traceProtocolVersion as Record<string, unknown>;
    expect(pv.initializeBody).toEqual({ state: "present", value: "2025-11-25" });
    expect(pv.headerOnMcpTraffic).toEqual({
      state: "present",
      value: ["2025-11-25"],
    });
    // Carried through as the OBSERVATION, not flattened to a boolean: the profile
    // is where a partial capture would otherwise become a "these wires agree"
    // claim, so the tri-state has to survive the projection.
    expect(pv.wiresDisagree).toEqual({ state: "present", value: false });

    // Provenance points back at the artifact, including the staleness stamp.
    const provenance = extensions.traceProvenance as Record<string, unknown>;
    expect(provenance.traceId).toBe(
      "mcpjam/in-memory-dcr-authcode-prm-mcp2025-11-25/2026-07-29/emulator",
    );
    expect(provenance.oauthImplementation).toEqual({
      state: "present",
      value: { kind: "first-party" },
    });
  });

  it("marks dcrIdentity unverifiable when no registration happened", () => {
    const trace = loadTrace();
    const noDcr = reobserve({
      ...trace,
      wire: trace.wire.filter((exchange) => exchange.leg !== "dcr-register"),
    });

    const evidence = traceToOAuthProfile(noDcr).dcrIdentity;
    expect(evidence?.status).toBe("unverifiable");
    if (evidence?.status === "unverifiable") {
      // And the reason explains that this may be correct rather than a failure.
      expect(evidence.reason).toContain("CIMD or a pre-registered client_id");
    }
  });
});

describe("mergeTraceOAuthProfile", () => {
  const sourceRead: HostConfigOAuthProfileV1 = {
    profileVersion: 1,
    // Two fields a trace can never settle, already answered by a source-reading.
    authModel: {
      status: "verified",
      value: ["oauth2-dcr"],
      source: "E1 — src/oauth/provider.ts:41",
      capturedAt: "2026-07-01",
    },
    oauthSpecVersion: {
      status: "verified",
      value: { basis: "constant", revisions: ["2025-11-25"] },
      source: "E1 — src/oauth/versions.ts:12",
      capturedAt: "2026-07-01",
    },
    extensions: { sourceReadNotes: ["read against v1.4.0"] },
  };

  it("never lets an `unverifiable` projection overwrite settled evidence", () => {
    // The whole point: the projection emits `unverifiable` for every field it
    // could not settle, because naming the missing experiment is useful output.
    // A plain spread would therefore turn a verified `authModel` back into "a
    // trace cannot enumerate what a client supports" — evidence loss wearing the
    // clothes of an update.
    const projection = traceToOAuthProfile(loadTrace(), { tracePath: "traces/x.json" });
    expect(projection.authModel?.status).toBe("unverifiable");

    const merged = mergeTraceOAuthProfile(sourceRead, projection);
    expect(merged.authModel).toEqual(sourceRead.authModel);
    // `basis: "constant"` is stronger than the trace's behavioral FLOOR and is
    // not something a capture can ever justify, so the source-read survives.
    expect(merged.oauthSpecVersion).toEqual(sourceRead.oauthSpecVersion);
  });

  it("lets a trace win the fields it DID settle", () => {
    const projection = traceToOAuthProfile(loadTrace(), { tracePath: "traces/x.json" });
    const merged = mergeTraceOAuthProfile(
      {
        ...sourceRead,
        sendsResourceIndicator: {
          status: "unverifiable",
          reason: "closed-source client",
          capturedAt: "2026-07-01",
        },
      },
      projection,
    );

    expect(merged.sendsResourceIndicator).toEqual(projection.sendsResourceIndicator);
    expect(merged.dcrIdentity).toEqual(projection.dcrIdentity);
    // Extensions are additive: a schema gap must not cost another source's notes.
    const extensions = merged.extensions as Record<string, unknown>;
    expect(extensions.sourceReadNotes).toEqual(["read against v1.4.0"]);
    expect(extensions.traceProvenance).toBeDefined();
    expect(() => canonicalizeOAuthProfile(merged)).not.toThrow();
  });

  it("returns the projection unchanged for an uninvestigated host", () => {
    const projection = traceToOAuthProfile(loadTrace());
    expect(mergeTraceOAuthProfile(undefined, projection)).toBe(projection);
  });
});
