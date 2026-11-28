/**
 * Family 1: Server information. What the server says about itself in
 * `initialize` (2025 revisions) or `server/discover` and result `_meta`
 * (2026-07-28).
 */

import type { FeatureDefinition } from "../../types.js";
import { coreSpec } from "../spec-refs.js";
import {
  hasKeys,
  isNonEmptyString,
  isRecord,
  lifecycle,
  listDetail,
  notApplicableWhenComplete,
  present,
  absent,
  serverInfoField,
} from "./rules.js";

const DISCOVER = "server/discover";

export const SERVER_INFO_FEATURES: readonly FeatureDefinition[] = [
  {
    id: "server-info.name-version",
    family: "server-information",
    name: "Server name and version",
    summary: "Identifies the server implementation to clients and in logs.",
    howTo:
      "Set name and version in your server's implementation info. Every MCP SDK asks for them when you create the server.",
    owner: "server",
    spec: coreSpec("2026-07-28", DISCOVER),
    stage: "stable",
    lifecycle: {},
    optional: false,
    assessment: {
      primary: "declared",
      declared: serverInfoField(
        (info) => isNonEmptyString(info.name) && isNonEmptyString(info.version)
      ),
    },
  },
  {
    id: "server-info.title",
    family: "server-information",
    name: "Server title",
    summary:
      "A display name clients show instead of the programmatic server name.",
    howTo: "Set title in your server's implementation info.",
    owner: "server",
    spec: coreSpec("2026-07-28", DISCOVER),
    stage: "stable",
    lifecycle: lifecycle({ introduced: "2025-06-18" }),
    optional: true,
    assessment: {
      primary: "declared",
      declared: serverInfoField((info) => isNonEmptyString(info.title), {
        droppedByOldSnapshots: true,
      }),
    },
  },
  {
    id: "server-info.description",
    family: "server-information",
    name: "Server description",
    summary: "A short description of what the server does, shown to users.",
    howTo: "Set description in your server's implementation info.",
    owner: "server",
    spec: coreSpec("2026-07-28", DISCOVER),
    stage: "stable",
    lifecycle: lifecycle({ introduced: "2025-11-25" }),
    optional: true,
    assessment: {
      primary: "declared",
      declared: serverInfoField((info) => isNonEmptyString(info.description), {
        droppedByOldSnapshots: true,
      }),
    },
  },
  {
    id: "server-info.website-url",
    family: "server-information",
    name: "Website URL",
    summary: "Links users to the server's homepage or documentation.",
    howTo: "Set websiteUrl in your server's implementation info.",
    owner: "server",
    spec: coreSpec("2026-07-28", DISCOVER),
    stage: "stable",
    lifecycle: lifecycle({ introduced: "2025-11-25" }),
    optional: true,
    assessment: {
      primary: "declared",
      declared: serverInfoField((info) => isNonEmptyString(info.websiteUrl), {
        droppedByOldSnapshots: true,
      }),
    },
  },
  {
    id: "server-info.icons",
    family: "server-information",
    name: "Server icons",
    summary:
      "Icons clients show next to the server, with sizes, MIME types and light or dark themes.",
    howTo:
      "Add icons with src, mimeType and sizes to your server's implementation info. Serve them over HTTPS or as data URIs.",
    owner: "server",
    spec: coreSpec("2026-07-28", "basic/index", "icons"),
    stage: "stable",
    lifecycle: lifecycle({ introduced: "2025-11-25" }),
    optional: true,
    assessment: {
      primary: "declared",
      declared: serverInfoField(
        (info) =>
          Array.isArray(info.icons) &&
          info.icons.some(
            (icon: unknown) => isRecord(icon) && isNonEmptyString(icon.src)
          ),
        { droppedByOldSnapshots: true }
      ),
    },
  },
  {
    id: "server-info.instructions",
    family: "server-information",
    name: "Instructions",
    summary:
      "Guidance a client can give the model about how and when to use the server.",
    howTo:
      "Return an instructions string from initialize, or from server/discover on 2026-07-28.",
    owner: "server",
    spec: coreSpec("2026-07-28", DISCOVER),
    stage: "stable",
    lifecycle: {},
    optional: true,
    assessment: {
      primary: "declared",
      declared: (surface) =>
        isNonEmptyString(surface.instructions)
          ? present("advertised")
          : absent(["instructions"]),
    },
  },
  {
    id: "server-info.experimental",
    family: "server-information",
    name: "Experimental capabilities",
    summary:
      "Non-standard capabilities the server declares under capabilities.experimental.",
    howTo:
      "Declare a non-standard feature under capabilities.experimental with a namespaced key.",
    owner: "server",
    spec: coreSpec("2026-07-28", "schema", "servercapabilities"),
    stage: "stable",
    lifecycle: {},
    optional: true,
    assessment: {
      primary: "declared",
      declared: (surface) => {
        const experimental = surface.capabilities?.experimental;
        if (isRecord(experimental) && hasKeys(experimental)) {
          const keys = Object.keys(experimental);
          return present("advertised", {
            count: keys.length,
            detail: listDetail(keys),
          });
        }
        return notApplicableWhenComplete(
          surface,
          ["capabilities"],
          "The server declares no experimental capabilities."
        );
      },
    },
  },
  {
    id: "server-info.result-server-info",
    family: "server-information",
    name: "serverInfo on every result",
    summary:
      "Each result names the server in its _meta, so a stateless client always knows who answered.",
    howTo:
      "Add io.modelcontextprotocol/serverInfo to the _meta of every result. Use the server in Playground to see it on live traffic.",
    owner: "server",
    spec: coreSpec("2026-07-28", "schema", "resultmetaobject"),
    stage: "stable",
    lifecycle: lifecycle({ introduced: "2026-07-28" }),
    optional: true,
    assessment: {
      primary: "observed",
      observable: true,
      declared: (surface) =>
        isRecord(surface.discoveryMeta) &&
        isRecord(surface.discoveryMeta["io.modelcontextprotocol/serverInfo"])
          ? present("detected", { detail: "Seen on server/discover." })
          : null,
    },
  },
];
