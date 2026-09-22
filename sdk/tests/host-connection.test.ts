import { describe, expect, it } from "vitest";
import { hostConnectionProfile } from "../src/host-config/internal";
import {
  seedHostTemplate,
  type HostTemplateId,
} from "../src/host-config/templates/seed-host-template";

const profileFor = (id: HostTemplateId) =>
  hostConnectionProfile(
    seedHostTemplate(id) as unknown as Record<string, unknown>
  );

const extensions = (caps: Record<string, unknown> | undefined) =>
  (caps?.extensions ?? {}) as Record<string, unknown>;

describe("hostConnectionProfile", () => {
  it("derives Claude's identity + the MCP Apps UI capability", () => {
    const p = profileFor("claude");
    expect(p.clientInfo?.name).toBe("claude-ai");
    expect(
      extensions(p.clientCapabilities)["io.modelcontextprotocol/ui"]
    ).toBeDefined();
    // Claude's model filters app-only tools (default visibility policy).
    expect(p.respectToolVisibility).not.toBe(false);
  });

  it("pins Goose's advertised protocol version", () => {
    expect(profileFor("goose").supportedProtocolVersions).toContain(
      "2025-03-26"
    );
  });

  it("Cursor opts out of tool-visibility filtering", () => {
    expect(profileFor("cursor").respectToolVisibility).toBe(false);
  });

  it("ChatGPT advertises its experimental openai/visibility capability", () => {
    const experimental = (profileFor("chatgpt").clientCapabilities
      ?.experimental ?? {}) as Record<string, { enabled?: boolean }>;
    expect(experimental["openai/visibility"]?.enabled).toBe(true);
  });

  it("returns respectToolVisibility undefined for a config with no host fields", () => {
    expect(hostConnectionProfile({}).respectToolVisibility).toBeUndefined();
  });

  it("reads the protocol-version pin from mcpProfile (sibling of initialize)", () => {
    const p = hostConnectionProfile({
      mcpProfile: {
        mcpProtocolVersion: "2026-07-28",
        initialize: { clientInfo: { name: "x" } },
      },
    });
    expect(p.mcpProtocolVersion).toBe("2026-07-28");
    // A value mistakenly placed under initialize must NOT be read.
    expect(
      hostConnectionProfile({
        mcpProfile: { initialize: { mcpProtocolVersion: "2026-07-28" } },
      }).mcpProtocolVersion
    ).toBeUndefined();
  });

  it("reduces auto to no wire pin while preserving the nested connection profile", () => {
    const p = hostConnectionProfile({
      mcpProfile: {
        profileVersion: 1,
        mcpProtocolVersion: "auto",
        initialize: {
          supportedProtocolVersions: ["2025-11-25", "2026-07-28"],
          clientInfo: { name: "openai-mcp", version: "1.0.0" },
        },
      },
    });
    expect(p.mcpProtocolVersion).toBeUndefined();
    expect(p.supportedProtocolVersions).toEqual(["2025-11-25", "2026-07-28"]);
    expect(p.clientInfo).toMatchObject({
      name: "openai-mcp",
      version: "1.0.0",
    });
  });

  describe("toolParamHeaderMirroring → mirrorToolParamHeaders", () => {
    it('reduces "omit" to mirrorToolParamHeaders: false', () => {
      const p = hostConnectionProfile({
        mcpProfile: { profileVersion: 1, toolParamHeaderMirroring: "omit" },
      });
      expect(p.mirrorToolParamHeaders).toBe(false);
    });

    it('leaves the wire field ABSENT for "mirror" and for an absent field', () => {
      // Both say "mirror". Emitting `true` would put a field on every server
      // config that never carried one — absence is the conforming default.
      for (const mcpProfile of [
        { profileVersion: 1, toolParamHeaderMirroring: "mirror" },
        { profileVersion: 1 },
        undefined,
      ]) {
        const p = hostConnectionProfile(mcpProfile ? { mcpProfile } : {});
        expect(p.mirrorToolParamHeaders).toBeUndefined();
        expect("mirrorToolParamHeaders" in p).toBe(false);
      }
    });

    it("fails closed on an unrecognized literal", () => {
      // A future mode this SDK build does not know must not read as "omit".
      const p = hostConnectionProfile({
        mcpProfile: { profileVersion: 1, toolParamHeaderMirroring: "corrupt" },
      });
      expect(p.mirrorToolParamHeaders).toBeUndefined();
    });
  });

  describe("client-conformance knob reduction", () => {
    it("reduces each non-default literal to its wire field", () => {
      const p = hostConnectionProfile({
        mcpProfile: {
          profileVersion: 1,
          paginationTraversal: "firstPageOnly",
          mrtrSupport: "none",
          toolCallCancellation: { legacy: false, modern: false },
        },
      });
      expect(p.firstPageOnly).toBe(true);
      expect(p.supportsMrtr).toBe(false);
      expect(p.toolCallCancellation).toEqual({ legacy: false, modern: false });
    });

    it("collapses default literals AND absent fields to no wire field", () => {
      for (const mcpProfile of [
        {
          profileVersion: 1,
          paginationTraversal: "full",
          mrtrSupport: "full",
          toolCallCancellation: { legacy: true, modern: true },
        },
        { profileVersion: 1 },
        undefined,
      ]) {
        const p = hostConnectionProfile(mcpProfile ? { mcpProfile } : {});
        for (const key of [
          "firstPageOnly",
          "supportsMrtr",
          "toolCallCancellation",
        ]) {
          expect(key in p).toBe(false);
        }
      }
    });

    it("reduces the toolListChanged record per leaf", () => {
      const p = hostConnectionProfile({
        mcpProfile: {
          profileVersion: 1,
          toolListChanged: { listens: false, refetches: false },
        },
      });
      expect(p.suppressListenChannel).toBe(true);
      expect(p.dropToolListChanged).toBe(true);
    });

    it("reduces only the leaf that is set", () => {
      // ChatGPT's real shape: measured not-listening, with `refetches`
      // deliberately unmeasured because nothing is ever delivered to it.
      const p = hostConnectionProfile({
        mcpProfile: {
          profileVersion: 1,
          toolListChanged: { listens: false },
        },
      });
      expect(p.suppressListenChannel).toBe(true);
      expect("dropToolListChanged" in p).toBe(false);
    });

    it("collapses true leaves, an empty record, and absence alike", () => {
      for (const toolListChanged of [
        { listens: true, refetches: true },
        {},
        undefined,
      ]) {
        const p = hostConnectionProfile({
          mcpProfile: { profileVersion: 1, ...(toolListChanged ? { toolListChanged } : {}) },
        });
        expect("suppressListenChannel" in p).toBe(false);
        expect("dropToolListChanged" in p).toBe(false);
      }
    });

    it("forwards only the degraded leaves, never resolving the era here", () => {
      // Resolution is the SDK's job at request time: on an unpinned host the
      // era does not exist yet, and picking one here made the other era's
      // toggle unreachable.
      const forward = (toolCallCancellation: Record<string, unknown>) =>
        hostConnectionProfile({
          mcpProfile: { profileVersion: 1, toolCallCancellation },
        }).toolCallCancellation;

      expect(forward({ legacy: false })).toEqual({ legacy: false });
      expect(forward({ modern: false })).toEqual({ modern: false });
      // Conforming and malformed leaves are dropped, so an all-good host emits
      // nothing and keeps hashing as it did before the field existed.
      expect(forward({ legacy: true, modern: false })).toEqual({
        modern: false,
      });
      expect(forward({ legacy: "false" })).toBeUndefined();
    });

    it("is unaffected by the version pin", () => {
      // The pin used to decide the leaf here. It must not any more — a pinned
      // and an unpinned host forward the same thing.
      for (const mcpProtocolVersion of ["2026-07-28", "2025-11-25", "auto"]) {
        expect(
          hostConnectionProfile({
            mcpProfile: {
              profileVersion: 1,
              mcpProtocolVersion,
              toolCallCancellation: { legacy: false },
            },
          }).toolCallCancellation
        ).toEqual({ legacy: false });
      }
    });

    it("fails closed on unrecognized literals", () => {
      // A future mode this SDK build does not know must not read as the
      // non-default value.
      const p = hostConnectionProfile({
        mcpProfile: {
          profileVersion: 1,
          paginationTraversal: "everyOtherPage",
          mrtrSupport: "partial",
          // Not a record at all, and a record with an unknown leaf: neither
          // may read as the degraded value.
          toolCallCancellation: "sometimes",
        },
      });
      expect("toolCallCancellation" in p).toBe(false);
      expect("firstPageOnly" in p).toBe(false);
      expect("supportsMrtr" in p).toBe(false);
    });
  });
});
