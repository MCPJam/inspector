/**
 * Family 23: Server Cards (Beta). Every leaf comes from the `server-card`
 * probe, which follows the AI Catalog and then the hosted
 * `<streamable-http-url>/server-card` location. Cards never list tools or
 * other primitives, and a card that contradicts runtime serverInfo stays
 * advisory: the row shows the conflict instead of a gap.
 */

import type {
  FeatureDefinition,
  FeatureRuleOutcome,
  ProbeSummary,
  ProbeSurface,
  ProbeValueKeysMap,
} from "../../types.js";
import {
  familyFeature,
  probeBlocker,
  probeBoolean,
  probeString,
  probeStrings,
  specAt,
} from "./shared.js";

type CardKey = ProbeValueKeysMap["server-card"];
type CardProbe = ProbeSummary<"server-card">;

const feature = familyFeature("server-cards", "beta");
const LABEL = "Server Card";
const HOSTED_PATH = "/server-card";
const NO_CARD = "No Server Card was found.";

function cardProbe(
  probes: ProbeSurface
): { outcome: FeatureRuleOutcome } | { probe: CardProbe } {
  const probe = probes["server-card"];
  const blocked = probeBlocker(probe, LABEL);
  if (blocked !== undefined || !probe) return { outcome: blocked ?? null };
  return { probe };
}

function absentIfComplete(
  probe: CardProbe,
  detail?: string
): FeatureRuleOutcome {
  if (probe.coverage !== "complete") {
    return {
      kind: "unknown",
      reason: "The Server Card check finished only in part.",
    };
  }
  return detail === undefined
    ? { kind: "absent", basis: [] }
    : { kind: "absent", basis: [], detail };
}

/**
 * Present when `key` is true; absent (optional) or unknown (required) when
 * false. A field the card only lists is a declaration (`advertised`); a
 * property MCPJam tested, such as CORS or HTTPS, was probed.
 */
function cardField(
  key: CardKey,
  options: {
    needsCard: boolean;
    whenFalse: "absent" | string;
    via?: "advertised";
  }
) {
  return (probes: ProbeSurface): FeatureRuleOutcome => {
    const read = cardProbe(probes);
    if ("outcome" in read) return read.outcome;
    const { probe } = read;
    if (
      options.needsCard &&
      probeBoolean(probe.values.serverCardFound) !== true
    ) {
      return { kind: "not-applicable", reason: NO_CARD };
    }
    const value = probeBoolean(probe.values[key]);
    if (value === true)
      return { kind: "present", via: options.via ?? "probed" };
    if (value === undefined)
      return {
        kind: "unknown",
        reason: "This part of the card was not checked.",
      };
    return options.whenFalse === "absent"
      ? absentIfComplete(probe)
      : { kind: "unknown", reason: options.whenFalse };
  };
}

function probedCardFeature(
  input: Pick<FeatureDefinition, "id" | "name" | "summary" | "howTo" | "spec"> &
    Partial<Pick<FeatureDefinition, "optional">>,
  probed: (probes: ProbeSurface) => FeatureRuleOutcome
): FeatureDefinition {
  return feature({ ...input, assessment: { primary: "probed", probed } });
}

export const SERVER_CARD_FEATURES: readonly FeatureDefinition[] = [
  probedCardFeature(
    {
      id: "server-cards.ai-catalog",
      name: "AI Catalog (/.well-known/ai-catalog.json)",
      summary:
        "A domain-level catalog that points clients to the server's card before they connect.",
      howTo:
        "Publish /.well-known/ai-catalog.json on your domain with the media type application/ai-catalog+json.",
      spec: specAt("server-card-discovery", "well-known-uri"),
    },
    cardField("aiCatalogFound", { needsCard: false, whenFalse: "absent" })
  ),
  probedCardFeature(
    {
      id: "server-cards.catalog-entry",
      name: "Server Card entry in the AI Catalog",
      summary: "The catalog lists this server's card by URL or inline data.",
      howTo:
        "Add an entry with type application/mcp-server-card+json and the card's url or data to your AI Catalog.",
      spec: specAt("server-card-discovery", "server-card-entries"),
    },
    (probes) => {
      const read = cardProbe(probes);
      if ("outcome" in read) return read.outcome;
      if (probeBoolean(read.probe.values.aiCatalogFound) !== true) {
        return { kind: "not-applicable", reason: "No AI Catalog was found." };
      }
      return cardField("catalogEntryFound", {
        needsCard: false,
        whenFalse: "absent",
      })(probes);
    }
  ),
  probedCardFeature(
    {
      id: "server-cards.hosted-card",
      name: "Hosted card at <server URL>/server-card",
      summary:
        "Clients that know the server URL can fetch its card without an AI Catalog.",
      howTo:
        "Serve the card with GET at your Streamable HTTP URL followed by /server-card.",
      spec: specAt("server-card-discovery", "hosted-server-card-location"),
    },
    (probes) => {
      const read = cardProbe(probes);
      if ("outcome" in read) return read.outcome;
      const url = probeString(read.probe.values.serverCardUrl);
      if (
        probeBoolean(read.probe.values.serverCardFound) === true &&
        url?.endsWith(HOSTED_PATH)
      ) {
        return { kind: "present", via: "probed" };
      }
      return absentIfComplete(read.probe);
    }
  ),
  probedCardFeature(
    {
      id: "server-cards.media-type",
      name: "Media type application/mcp-server-card+json",
      summary: "Clients recognize the response as a Server Card.",
      howTo:
        "Serve the card with Content-Type application/mcp-server-card+json.",
      optional: false,
      spec: specAt("server-card-discovery", "hosted-server-card-location"),
    },
    cardField("mediaTypeOk", {
      needsCard: true,
      whenFalse: "The card was served with a different media type.",
    })
  ),
  probedCardFeature(
    {
      id: "server-cards.required-fields",
      name: "Required fields ($schema, name, version, description)",
      summary:
        "The card identifies the server with a schema URL, reverse-DNS name, version and short description.",
      howTo:
        "Include $schema, a reverse-DNS name, version and a description of at most 100 characters.",
      optional: false,
      spec: specAt("server-card-schema"),
    },
    (probes) => {
      const read = cardProbe(probes);
      if ("outcome" in read) return read.outcome;
      const missing = probeStrings(read.probe.values.missingFields) ?? [];
      return cardField("requiredFieldsOk", {
        needsCard: true,
        whenFalse:
          missing.length > 0
            ? `The card is missing ${missing.join(", ")}.`
            : "The card is missing required fields.",
      })(probes);
    }
  ),
  probedCardFeature(
    {
      id: "server-cards.optional-fields",
      name: "title, websiteUrl, repository and icons",
      summary:
        "Optional fields that help people recognize the server in a directory.",
      howTo: "Add title, websiteUrl, repository and icons to the card.",
      spec: specAt("server-card-schema"),
    },
    (probes) => {
      const read = cardProbe(probes);
      if ("outcome" in read) return read.outcome;
      if (probeBoolean(read.probe.values.serverCardFound) !== true) {
        return { kind: "not-applicable", reason: NO_CARD };
      }
      const fields = probeStrings(read.probe.values.optionalFields);
      if (fields === undefined)
        return { kind: "unknown", reason: "Optional fields were not checked." };
      return fields.length > 0
        ? {
            kind: "present",
            via: "advertised",
            count: fields.length,
            detail: fields.join(", "),
          }
        : absentIfComplete(read.probe);
    }
  ),
  probedCardFeature(
    {
      id: "server-cards.remotes",
      name: "remotes",
      summary:
        "Lists the server's endpoints with transport type, URL, headers, variables and supported protocol versions.",
      howTo:
        "Add a remotes entry for each endpoint, with type streamable-http or sse and its url.",
      spec: specAt("server-card-schema"),
    },
    cardField("remotesListed", {
      needsCard: true,
      whenFalse: "absent",
      via: "advertised",
    })
  ),
  probedCardFeature(
    {
      id: "server-cards.meta",
      name: "Card _meta",
      summary: "Carries vendor metadata alongside the card's standard fields.",
      howTo:
        "Add a _meta object to the card for metadata outside the standard fields.",
      spec: specAt("server-card-schema"),
    },
    cardField("hasMeta", {
      needsCard: true,
      whenFalse: "absent",
      via: "advertised",
    })
  ),
  probedCardFeature(
    {
      id: "server-cards.runtime-consistency",
      name: "Consistent with runtime serverInfo",
      summary:
        "The card's name, version and remotes do not contradict what the server reports when connected.",
      howTo:
        "Generate the card from the same name and version the server reports in serverInfo.",
      spec: specAt(
        "server-card-discovery",
        "consistency-with-runtime-behavior"
      ),
    },
    (probes) => {
      const read = cardProbe(probes);
      if ("outcome" in read) return read.outcome;
      if (probeBoolean(read.probe.values.serverCardFound) !== true) {
        return { kind: "not-applicable", reason: NO_CARD };
      }
      const consistent = probeBoolean(read.probe.values.consistentWithRuntime);
      if (consistent === true) return { kind: "present", via: "probed" };
      return {
        kind: "unknown",
        reason:
          consistent === false
            ? "The card contradicts what the server reports at runtime. The card is advisory, so the runtime values apply."
            : "The card was not compared with the running server yet.",
      };
    }
  ),
  probedCardFeature(
    {
      id: "server-cards.cors",
      name: "CORS headers",
      summary: "Browser-based clients can fetch the card from another origin.",
      howTo:
        "Send Access-Control-Allow-Origin on the card and catalog responses.",
      optional: false,
      spec: specAt("server-card-discovery", "cors-requirements"),
    },
    cardField("corsAllowed", {
      needsCard: true,
      whenFalse:
        "The card response has no CORS headers, so browser clients cannot read it.",
    })
  ),
  probedCardFeature(
    {
      id: "server-cards.caching",
      name: "Cache-Control, ETag and 304",
      summary: "Clients can cache the card and revalidate it cheaply.",
      howTo:
        "Send Cache-Control and an ETag with the card, and answer If-None-Match with 304.",
      spec: specAt("server-card-discovery", "caching"),
    },
    cardField("cacheControl", { needsCard: true, whenFalse: "absent" })
  ),
  probedCardFeature(
    {
      id: "server-cards.https",
      name: "HTTPS",
      summary:
        "The card is served over HTTPS so clients can trust what it says.",
      howTo: "Serve the AI Catalog and the card over HTTPS.",
      optional: false,
      spec: specAt("server-card-discovery", "transport-security"),
    },
    cardField("https", {
      needsCard: true,
      whenFalse: "The card is served over plain HTTP.",
    })
  ),
];
