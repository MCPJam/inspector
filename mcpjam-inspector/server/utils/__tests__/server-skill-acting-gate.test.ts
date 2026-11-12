/**
 * The acting-skill gate (SEP-2640): while a server's skill is in the
 * conversation, the shell and the cross-server resource read ask, whatever
 * the host's switch says.
 *
 * PIN: modelcontextprotocol/ext-skills @ c1aa87e (`specification/stable/skills.mdx`).
 */

import { describe, expect, it, vi } from "vitest";
import { actingServerSkills } from "../../../shared/server-skill-banner";
import { BODY, SKILL_URI } from "../../test/support/server-skill-wire";
import { serverSkillBanner } from "../computers/server-skill-reads";
import {
  actingServerSkillGateCanFire,
  applyActingServerSkillGate,
  unwrapActingServerSkillGate,
} from "../server-skill-acting-gate";

describe("the acting-skill gate", () => {
  const banner = serverSkillBanner({
    ref: "acme-billing/refunds",
    serverLabel: "Acme Billing",
    skillUri: SKILL_URI,
  });
  const acting = [
    {
      role: "tool" as const,
      content: [
        {
          type: "tool-result" as const,
          toolCallId: "c1",
          toolName: "loadSkill",
          output: { type: "text" as const, value: `${banner}${BODY}` },
        },
      ],
    },
  ];

  it("raises the shell and the resource read to ask while a server skill is loaded", async () => {
    const tools: Record<string, unknown> = applyActingServerSkillGate({
      bash: { needsApproval: false, execute: vi.fn() },
      read_server_resource: { needsApproval: false, execute: vi.fn() },
      web_search: { needsApproval: false, execute: vi.fn() },
    });
    const ask = (name: string, messages: unknown) =>
      (
        tools[name] as {
          needsApproval: (input: unknown, options: unknown) => Promise<boolean>;
        }
      ).needsApproval({}, { messages });
    expect(await ask("bash", acting)).toBe(true);
    expect(await ask("read_server_resource", acting)).toBe(true);
    expect(await ask("bash", [])).toBe(false);
    // Only the named tools are gated.
    expect((tools.web_search as { needsApproval: unknown }).needsApproval).toBe(
      false,
    );
  });

  it("fails closed: a banner the parser cannot read still closes the gate", async () => {
    // The marker alone decides. A server must not be able to switch the gate
    // off by shaping its URI so the origin line no longer parses.
    const tools: Record<string, unknown> = applyActingServerSkillGate({
      bash: { needsApproval: false, execute: vi.fn() },
    });
    const gate = (
      tools.bash as {
        needsApproval: (input: unknown, options: unknown) => Promise<boolean>;
      }
    ).needsApproval;
    const unparseable = [
      {
        role: "user",
        content: `# Skill: x\n\n> Origin: MCP server "a)b" (c"d) garbage`,
      },
    ];
    expect(actingServerSkills(unparseable as never)).toEqual([]);
    expect(await gate({}, { messages: unparseable })).toBe(true);
  });

  it("raises only: a tool that already asks is left exactly as declared", async () => {
    // A literal `true` stays a literal `true`. The local org runtime refuses
    // a turn on that value, and a wrapper would hide it from the runtime.
    const tools: Record<string, unknown> = applyActingServerSkillGate({
      bash: { needsApproval: true, execute: vi.fn() },
    });
    expect((tools.bash as { needsApproval: unknown }).needsApproval).toBe(true);
  });

  it("lets a runtime read the declaration under its wrapper, and tell when it can fire", async () => {
    const tools: Record<string, unknown> = applyActingServerSkillGate({
      bash: { needsApproval: false, execute: vi.fn() },
      web_search: { needsApproval: false, execute: vi.fn() },
    });
    const wrapped = (tools.bash as { needsApproval: unknown }).needsApproval;
    expect(typeof wrapped).toBe("function");
    expect(unwrapActingServerSkillGate(wrapped)).toBe(false);
    expect(unwrapActingServerSkillGate(true)).toBe(true);
    const fn = () => true;
    expect(unwrapActingServerSkillGate(fn)).toBe(fn);
    // Fires only with a gated tool AND a server skill in context.
    expect(actingServerSkillGateCanFire(tools, acting)).toBe(true);
    expect(actingServerSkillGateCanFire(tools, [])).toBe(false);
    expect(
      actingServerSkillGateCanFire({ web_search: tools.web_search }, acting),
    ).toBe(false);
  });
});
