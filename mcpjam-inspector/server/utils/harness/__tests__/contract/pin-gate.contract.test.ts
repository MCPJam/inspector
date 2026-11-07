/**
 * The pin-change gate.
 *
 * A runtime pin may not move while the discovery evidence still names the old
 * version, and every place a pin is written must agree. Passing here proves
 * declarations agree with each other. It does not prove Apps, elicitation or
 * Tasks survive an upgrade: that takes a live qualification run at the new
 * pin, recorded as an evidence row.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Harness } from "@mcpjam/sdk/host-config/internal";
import {
  HARNESS_PINNED_VERSIONS,
  harnessNativeDiscoverySupport,
  type HarnessDiscoveryRoute,
} from "@/shared/harness-model-support";
import { PINNED_CODEX_VERSION } from "../../codex-appserver/bridge/app-server-protocol";
import { CURSOR_CLI_VERSION } from "../../cursor-bootstrap";
import { isNativeElicitationProfile } from "../../forwarding/native-elicitation-profile";
import { LOCAL_HARNESS_MANIFEST } from "../../local/compatibility";
import { assertNativeDiscovery } from "../../native-discovery";
import {
  CASES,
  OWN_MODEL,
  assertFullMatrix,
  sortKeysDeep,
  type ContractCase,
} from "./support";

it("covers every registered harness", assertFullMatrix);

const HARNESS_DIR = join(__dirname, "../..");
const INSPECTOR_DIR = join(HARNESS_DIR, "../../..");
const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));

const LABELS = [
  "forwarded-native",
  "forwarded-bridge",
  "native-proxy",
  "host-tools",
] as const;

/** Routes with a live qualification row at the current pin. */
const QUALIFIED_DISCOVERY: Record<Harness, readonly (typeof LABELS)[number][]> =
  {
    "claude-code": ["forwarded-bridge", "host-tools"],
    codex: ["forwarded-bridge", "host-tools"],
    cursor: [],
  };

const REQUALIFY = [
  "1. Run the native discovery qualification on staging at the new pin.",
  "2. Add its evidence row to shared/harness-model-support-evidence.json.",
  "3. Update the evidence sha256 in shared/__tests__/harness-model-support.test.ts.",
  "4. Copy the table to the backend and re-pin it: npm run check:mirrors -- --write.",
  "5. Last, regenerate the declaration snapshot: UPDATE_HARNESS_CAPABILITY_MATRIX=1.",
].join("\n");

function hostedChatRoute(
  { id, adapter }: ContractCase,
  delivery: HarnessDiscoveryRoute["delivery"],
): HarnessDiscoveryRoute {
  return {
    runtimeVersion: adapter.pinnedRuntimeVersion ?? "",
    adapterVersion: adapter.forwardingRuntime?.configurationVersion ?? "",
    protocolVersion: "2026-07-28",
    modelId: OWN_MODEL[id],
    delivery,
    venue: "hosted",
    surface: "chat",
    funding: "platform",
    upstreamProfile: "gateway",
  };
}

describe.each(CASES)("$id discovery evidence at the current pin", (entry) => {
  it.each(LABELS)("%s is qualified exactly when the table says so", (label) => {
    const route = hostedChatRoute(entry, label);
    const verdict = harnessNativeDiscoverySupport({
      harnessId: entry.id,
      route,
    });
    const required = () =>
      assertNativeDiscovery({ required: true, harnessId: entry.id, route });
    if (QUALIFIED_DISCOVERY[entry.id].includes(label)) {
      expect(
        verdict.status,
        `${entry.id} ${label} has no discovery evidence at runtime ` +
          `${route.runtimeVersion}, adapter ${route.adapterVersion}.\n${REQUALIFY}`,
      ).toBe("supported");
      expect(required).not.toThrow();
    } else {
      expect(
        verdict.status,
        `${entry.id} ${label} now has evidence: add it to QUALIFIED_DISCOVERY.`,
      ).toBe("unknown");
      expect(required).toThrow(/qualified/);
    }
  });
});

function pinSites({
  id,
  adapter,
  descriptor,
}: ContractCase): Array<[string, unknown]> {
  const bake = readJson(join(INSPECTOR_DIR, "harness-bake.lock.json")) as {
    recipes: Array<{ harnessId: string; runtimeVersion: string }>;
  };
  const sites: Array<[string, unknown]> = [
    ["HARNESS_PINNED_VERSIONS", HARNESS_PINNED_VERSIONS[id]],
    ["adapter.pinnedRuntimeVersion", adapter.pinnedRuntimeVersion],
    [
      "harness-bake.lock.json",
      bake.recipes.find((recipe) => recipe.harnessId === id)?.runtimeVersion,
    ],
  ];
  if (adapter.forwardingRuntime) {
    sites.push([
      "adapter.forwardingRuntime.runtimeVersion",
      adapter.forwardingRuntime.runtimeVersion,
    ]);
  }
  if (id === "claude-code") {
    const require = createRequire(import.meta.url);
    const bridge = readJson(
      join(
        dirname(require.resolve("@ai-sdk/harness-claude-code/package.json")),
        "dist/bridge/package.json",
      ),
    ) as { dependencies: Record<string, string> };
    sites.push([
      "@ai-sdk/harness-claude-code bridge",
      bridge.dependencies["@anthropic-ai/claude-code"],
    ]);
    sites.push([
      "isNativeElicitationProfile",
      isNativeElicitationProfile(
        { elicitation: { form: {} }, roots: { listChanged: true } },
        descriptor.runtimeVersion,
      )
        ? descriptor.runtimeVersion
        : "not qualified at this pin",
    ]);
  }
  if (id === "codex") {
    const bootstrap = readJson(
      join(HARNESS_DIR, "codex-appserver/bootstrap/package.json"),
    ) as {
      dependencies: Record<string, string>;
    };
    const schemas = readdirSync(
      join(HARNESS_DIR, "codex-appserver/__fixtures__/schema"),
    );
    sites.push(["PINNED_CODEX_VERSION", PINNED_CODEX_VERSION]);
    sites.push([
      "codex bootstrap package.json",
      bootstrap.dependencies["@openai/codex"],
    ]);
    sites.push([
      "codex schema fixture",
      schemas.includes(descriptor.runtimeVersion)
        ? readJson(
            join(
              HARNESS_DIR,
              "codex-appserver/__fixtures__/schema",
              descriptor.runtimeVersion,
              "MANIFEST.json",
            ),
          ).codexVersion
        : `none of ${schemas.join(", ")}`,
    ]);
  }
  if (id === "cursor") sites.push(["CURSOR_CLI_VERSION", CURSOR_CLI_VERSION]);
  return sites;
}

describe.each(CASES)("$id pins", (entry) => {
  it.each(pinSites(entry))("%s matches the descriptor", (_site, value) => {
    expect(value).toBe(entry.descriptor.runtimeVersion);
  });
});

it("pins the Claude Code adapter package exactly where the local manifest checks it", () => {
  const require = createRequire(import.meta.url);
  const installed = readJson(
    require.resolve("@ai-sdk/harness-claude-code/package.json"),
  ).version;
  const declared = readJson(join(INSPECTOR_DIR, "package.json")).dependencies[
    "@ai-sdk/harness-claude-code"
  ];
  expect(declared).toBe(installed);
  expect(LOCAL_HARNESS_MANIFEST["claude-code"].adapterVersion).toBe(installed);
});

const MATRIX = join(
  HARNESS_DIR,
  "__tests__/fixtures/harness-capability-matrix.json",
);

it("matches the reviewed declaration snapshot", () => {
  const matrix = sortKeysDeep(
    Object.fromEntries(
      CASES.map(({ id, adapter, descriptor }) => [
        id,
        {
          adapter: JSON.parse(JSON.stringify(adapter)),
          descriptor: JSON.parse(JSON.stringify(descriptor)),
          qualifiedDiscovery: QUALIFIED_DISCOVERY[id],
        },
      ]),
    ),
  );
  const text = `${JSON.stringify(matrix, null, 2)}\n`;
  if (process.env.UPDATE_HARNESS_CAPABILITY_MATRIX === "1") {
    writeFileSync(MATRIX, text);
    return;
  }
  expect(
    text,
    "An adapter or descriptor declaration changed. Review the diff; if the change " +
      "moves a pin, follow the re-qualification steps first. A snapshot update " +
      "alone does not establish support.",
  ).toBe(readFileSync(MATRIX, "utf8"));
});

it("skips no row in the contract suite", () => {
  const skipped = new RegExp(String.raw`\.(skip|todo|only)\(`);
  for (const file of readdirSync(__dirname)) {
    expect(readFileSync(join(__dirname, file), "utf8"), file).not.toMatch(
      skipped,
    );
  }
});
