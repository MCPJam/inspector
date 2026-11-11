/**
 * The skills-delivered event, as eval turns report it: one event per planned
 * iteration and one for a run stopped before its first model call. Only the
 * PostHog capture is mocked; the plans come from the real preparation code.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const capture = vi.hoisted(() => vi.fn());
vi.mock("../../../utils/analytics.js", () => ({
  captureServerEventForActor: capture,
}));

import { rebuildServerAnalytics } from "../../../../shared/strict-server-analytics";
import { RunPluginSnapshotError } from "../../evals/run-plugin-snapshot";
import {
  buildPinnedSkillSource,
  iterationTurnSkills,
} from "../../evals/pinned-skill-source";
import { reportSkillsDelivered } from "../skills-delivered-event";
import {
  authoredPin,
  evalRunPins,
  namePin,
  preparedRunSkills,
} from "../../../test/support/skill-delivery";

const NONE = {
  delivered_library_count: 0,
  delivered_plugin_count: 0,
  delivered_mcp_server_count: 0,
  delivered_local_count: 0,
  excluded_unsupported_harness_count: 0,
  excluded_server_skill_unsupported_count: 0,
  excluded_plugin_disabled_count: 0,
  excluded_name_collision_count: 0,
  excluded_invalid_skill_name_count: 0,
  excluded_over_cap_count: 0,
  excluded_omitted_from_catalog_count: 0,
  failed_count: 0,
  $process_person_profile: false,
};

/** The properties of every event the module sent, in order. */
function sent(): Array<Record<string, unknown>> {
  return capture.mock.calls.map(([actor, event, properties]) => {
    expect(event).toBe("skills_delivered");
    // The strict boundary keeps the personless id and every field as sent.
    expect(
      rebuildServerAnalytics(event, actor.distinctId, properties)?.properties,
    ).toEqual(properties);
    return properties;
  });
}

async function evalIteration(
  execution: { harness?: string },
  pins = evalRunPins(),
) {
  const run = await preparedRunSkills(pins);
  return iterationTurnSkills({
    pinnedSkillSource: run.pinnedSkillSource,
    execution,
  }).skills;
}

beforeEach(() => {
  // The module stays quiet under Vitest; these tests read what it would send.
  vi.stubEnv("VITEST", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("an eval iteration", () => {
  it("reports what MCPJam's agent was handed, by family", async () => {
    await evalIteration({});
    expect(sent()).toEqual([
      {
        ...NONE,
        surface: "eval",
        outcome: "ok",
        runtime: "agent",
        delivered_library_count: 1,
        delivered_plugin_count: 1,
        delivered_mcp_server_count: 1,
      },
    ]);
  });

  it("names the harness and counts what it leaves out by reason", async () => {
    await evalIteration({ harness: "claude-code" });
    await evalIteration({ harness: "cursor" });
    await evalIteration({ harness: "codex" }, [
      namePin("deploy"),
      namePin("Deploy_Tool"),
    ]);
    expect(sent()).toEqual([
      {
        ...NONE,
        surface: "eval",
        outcome: "ok",
        runtime: "harness",
        harness_id: "claude-code",
        delivered_library_count: 1,
        delivered_plugin_count: 1,
        delivered_mcp_server_count: 1,
      },
      {
        ...NONE,
        surface: "eval",
        outcome: "ok",
        runtime: "harness",
        harness_id: "cursor",
        excluded_unsupported_harness_count: 3,
      },
      {
        ...NONE,
        surface: "eval",
        outcome: "ok",
        runtime: "harness",
        harness_id: "codex",
        delivered_library_count: 1,
        excluded_invalid_skill_name_count: 1,
      },
    ]);
  });

  it("reports nothing for an iteration without skills", async () => {
    await evalIteration({}, []);
    iterationTurnSkills({ execution: {} });
    expect(capture).not.toHaveBeenCalled();
  });

  it("reports partial and failed from what the turn says arrived", async () => {
    const skills = await evalIteration({ harness: "claude-code" });
    capture.mockClear();
    const [first, ...rest] = skills.delivered;
    reportSkillsDelivered("eval", skills, {
      delivered: rest,
      failed: [{ ref: first!, error: "The box refused the write." }],
    });
    reportSkillsDelivered("eval", skills, {
      delivered: [],
      failed: skills.delivered.map((ref) => ({ ref, error: "No box." })),
    });
    const base = { ...NONE, surface: "eval", runtime: "harness" };
    expect(sent()).toEqual([
      {
        ...base,
        harness_id: "claude-code",
        outcome: "partial",
        delivered_plugin_count: 1,
        delivered_mcp_server_count: 1,
        failed_count: 1,
      },
      {
        ...base,
        harness_id: "claude-code",
        outcome: "failed",
        failed_count: 3,
      },
    ]);
  });

  it("never sends a skill's name, id, ref or content", async () => {
    await evalIteration({});
    await evalIteration({ harness: "claude-code" });
    const text = JSON.stringify(sent());
    for (const pin of evalRunPins()) {
      for (const value of [
        pin.name,
        pin.skillId,
        pin.serverSkillId,
        pin.modelRef,
        pin.description,
        pin.content,
      ]) {
        if (value) expect(text).not.toContain(value);
      }
    }
  });
});

describe("an eval run stopped before its first model call", () => {
  const unreachable = authoredPin({
    files: [{ path: "scripts/check.sh", contentHash: "h", size: 1, url: null }],
  });
  const undownloadable = authoredPin({
    files: [
      {
        path: "scripts/check.sh",
        contentHash: "h",
        size: 1,
        url: "https://blobs.example.test/check.sh",
      },
    ],
  });

  it.each([
    ["is no longer stored", unreachable],
    ["cannot be downloaded", undownloadable],
  ])("reports failed when a frozen file %s", async (_, pin) => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    await expect(
      buildPinnedSkillSource({
        pins: [pin, namePin("triage")],
        pluginVersions: [],
        pluginServers: [],
        effectiveServerIds: [],
      }),
    ).rejects.toBeInstanceOf(RunPluginSnapshotError);
    expect(sent()).toEqual([
      { ...NONE, surface: "eval", outcome: "failed", failed_count: 2 },
    ]);
  });
});

it("sends nothing while Vitest runs", async () => {
  vi.unstubAllEnvs();
  await evalIteration({});
  expect(capture).not.toHaveBeenCalled();
});
