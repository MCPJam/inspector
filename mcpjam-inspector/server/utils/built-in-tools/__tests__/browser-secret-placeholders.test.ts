import { verifyLocalBrowserConsent } from "../../computers/browser-consent.js";
vi.mock("../../computers/browser-consent.js", () => ({
  verifyLocalBrowserConsent: vi.fn(async () => true),
}));
/**
 * `{{secret:NAME}}` at the TOOL layer — what the model is told, what it may
 * write, and what leaves this process.
 *
 * Every case here is one sentence about a value the model must never learn:
 *
 *   - a turn with no secrets reads EXACTLY the wording it read before this
 *     existed, because eval transcripts are diffed line by line;
 *   - a placeholder that cannot work is refused while the page is untouched,
 *     because the alternative is a literal `{{secret:PW}}` in a login form;
 *   - the value travels as a SIBLING of the command, so no ledger writer, no
 *     `/v1/trace` reader and no durable mirror is ever handed it;
 *   - and what comes back names the secret rather than showing it.
 */
import { describe, expect, it, vi } from "vitest";
import {
  buildBrowserTools,
  BrowserTokenMemory,
  describeBrowserTools,
} from "../browser";
import type { BrowserSessionHandle } from "../../../services/browserd/browser-session";
import { buildResolvedModelRequestPayload } from "../../model-request-payload";

const PASSWORD = "hunter2-hunter2-hunter2";
const SECRETS = [{ name: "GITHUB_PASSWORD", value: PASSWORD }];

type Sent = {
  command: any;
  bootId?: string;
  options?: { secrets?: ReadonlyArray<{ name: string; value: string }> };
};

function build(
  over: Record<string, any> = {},
  daemonFeatures: string[] = ["secret-placeholders"],
  reply: (command: any) => any = () => ({
    ok: true,
    output: { url: "https://x.test", a11y: 'textbox "Password"' },
    stateToken: { tabId: "@session", navCounter: 1, urlHash: "u", domHash: "d" },
    settled: true,
  }),
) {
  const sent: Sent[] = [];
  const sendCommand = vi.fn(
    async (command: any, bootId?: string, options?: any) => {
      sent.push({ command, bootId, options });
      return { status: "ok", result: reply(command), bootId: "boot-1" };
    },
  );
  const ensureSession = vi.fn(
    async (): Promise<BrowserSessionHandle> =>
      ({
        engine: "hosted" as const,
        target: "computer" as const,
        sessionId: "session-1",
        computerId: "computer-1",
        bootId: "boot-1",
        client: {
          sendCommand,
          status: async () => ({ kind: "ok", features: daemonFeatures }),
        } as never,
        streamUrl: "https://stream.example/vnc.html",
        streamPassword: "pw",
        contextMode: "persistent",
        reused: true,
      }) as BrowserSessionHandle,
  );
  const result = buildBrowserTools({
    authHeader: "Bearer user",
    projectId: "project-1",
    approvalDelivery: { kind: "attested" },
    pageTools: {
      tools: [],
      bootId: "boot-1",
      tabId: "@session",
      navCounter: 0,
      canBind: true,
    },
    ensureSession,
    tokenMemory: new BrowserTokenMemory(),
    ...over,
  });
  return { tools: result!.tools, sent, sendCommand };
}

const act = (tools: any, args: Record<string, unknown>) =>
  tools.browser_act.execute(args, { toolCallId: "call-1" });

/**
 * The wording of one tool AS THE MODEL RECEIVES IT.
 *
 * Through the real serializer, not the zod object: `.describe()` text is
 * metadata that never appears in a `_def` dump, so comparing those would
 * compare the two things this change does not touch and pass either way.
 */
const schemaOf = (tools: any, name: string) =>
  JSON.stringify(
    buildResolvedModelRequestPayload({ systemPrompt: "", tools, messages: [] })
      .tools[name],
  );

describe("what the model is told", () => {
  /**
   * The two descriptions this feature touches, PINNED as they read at the
   * release before it existed.
   *
   * Pinned literally rather than compared build-to-build, and the difference
   * is the whole value of the test: comparing a no-secrets build against
   * another no-secrets build passes just as happily when the wording is
   * unconditionally wrong, because both sides moved together. Only a fixed
   * string catches a note that leaked onto every turn.
   */
  const HEAD_VALUE_DESCRIPTION =
    'Text to type, key to press ("Enter"), scroll amount ("down"/"up"/pixels), ' +
    'drag destination ("x,y" in the same viewport coordinates), or option ' +
    "value to select.";
  const HEAD_FIELDS_DESCRIPTION = "For fill_form: fields to fill, in order.";

  const describedAct = (tools: any) =>
    JSON.parse(schemaOf(tools, "browser_act")).inputSchema.properties;

  it("is BYTE-IDENTICAL when the turn has no secrets", () => {
    // The bar for every flagged change in this stack: a transcript from a turn
    // that has nothing to offer must diff clean against the release before it.
    for (const tools of [
      build().tools,
      build({ secrets: { available: [] } }).tools,
    ]) {
      const properties = describedAct(tools);
      expect(properties.value.description).toBe(HEAD_VALUE_DESCRIPTION);
      expect(properties.fields.description).toBe(HEAD_FIELDS_DESCRIPTION);
    }
  });

  it("is byte-identical for every OTHER tool even when the turn has secrets", () => {
    // `browser_act` is the only tool that gains a word. A note that reached
    // `browser_observe` or `browser_navigate` would change the wording of a
    // turn that cannot use it.
    const none = build().tools;
    const offered = build({ secrets: { available: SECRETS } }).tools;
    for (const name of Object.keys(none)) {
      if (name === "browser_act") continue;
      expect(schemaOf(offered, name), name).toBe(schemaOf(none, name));
    }
  });

  it("names the secrets — and only the names — when the turn has them", () => {
    const offered = build({ secrets: { available: SECRETS } }).tools;
    const wording = schemaOf(offered, "browser_act");
    expect(wording).toContain("GITHUB_PASSWORD");
    expect(wording).toContain("{{secret:NAME}}");
    expect(wording).not.toContain(PASSWORD);
  });

  it("says nothing on the LOCAL engine, which cannot substitute", () => {
    const local = build({
      engine: "local",
      secrets: { available: SECRETS },
    }).tools;
    expect(describedAct(local).value.description).toBe(HEAD_VALUE_DESCRIPTION);
  });

  it("keeps `describeBrowserTools` free of any project's secret names", () => {
    // It feeds a tools pane and the host-configuration hash. A name in there
    // would rotate that hash for every project that adds a secret, and would
    // put one project's names in a description another project reads.
    expect(JSON.stringify(describeBrowserTools("hosted"))).not.toContain(
      "{{secret:",
    );
  });
});

describe("refusing a placeholder that cannot work", () => {
  it("refuses an unknown name without touching the page", async () => {
    const { tools, sent } = build({ secrets: { available: SECRETS } });
    const out = await act(tools, { verb: "type", value: "{{secret:NOPE}}" });
    expect(out.error).toContain("secret_unknown");
    expect(out.error).toContain("NOPE");
    expect(sent).toHaveLength(0);
  });

  it("refuses a placeholder on a verb that types nothing", async () => {
    // `press {{secret:X}}` asks for a KEY NAME; substituting a password there
    // would send several hundred unknown keystrokes.
    const { tools, sent } = build({ secrets: { available: SECRETS } });
    const out = await act(tools, {
      verb: "press",
      value: "{{secret:GITHUB_PASSWORD}}",
    });
    expect(out.error).toContain("secret_verb_refused");
    expect(sent).toHaveLength(0);
  });

  it("refuses a BROKERED name with its own reason", async () => {
    const { tools } = build({
      secrets: { available: SECRETS, brokered: ["EGRESS_KEY"] },
    });
    const out = await act(tools, { verb: "type", value: "{{secret:EGRESS_KEY}}" });
    expect(out.error).toContain("secret_not_typeable");
    expect(out.error).toContain("materialized");
  });

  it("still says `not typeable` when the environment is brokered-ONLY", async () => {
    // The environment that has nothing to type and every reason to say so.
    // The registry's gate read `browserSecrets?.length`, so an environment with
    // only brokered rows dropped the brokered names along with the empty
    // available list — and a name the user can plainly see configured came
    // back as "check the spelling" instead of "switch it to materialized".
    const { tools } = build({
      secrets: { available: [], brokered: ["EGRESS_KEY"] },
    });
    const out = await act(tools, { verb: "type", value: "{{secret:EGRESS_KEY}}" });
    expect(out.error).toContain("secret_not_typeable");
  });

  it("refuses every name when the surface wired no secrets", async () => {
    // The fail-closed position: absent is not "somebody else will supply it".
    const { tools, sent } = build();
    const out = await act(tools, { verb: "type", value: "{{secret:ANY}}" });
    expect(out.error).toContain("secret_unknown");
    expect(sent).toHaveLength(0);
  });

  it("refuses when the DAEMON cannot substitute, before sending", async () => {
    // An older build would type the placeholder itself and report success,
    // which the model reads as a wrong password.
    const { tools, sent } = build(
      { secrets: { available: SECRETS } },
      ["webmcp-binding"],
    );
    const out = await act(tools, {
      verb: "type",
      value: "{{secret:GITHUB_PASSWORD}}",
    });
    expect(out.error).toContain("secret_unsupported_daemon");
    expect(sent).toHaveLength(0);
  });

  it("refuses on the local engine, where a project credential has no business", async () => {
    const { tools, sent } = build({
      engine: "local",
      localConsentToken: "consent",
      secrets: { available: SECRETS },
    });
    const out = await act(tools, {
      verb: "type",
      value: "{{secret:GITHUB_PASSWORD}}",
    });
    expect(out.error).toContain("secret_engine_unsupported");
    expect(sent).toHaveLength(0);
  });

  it("leaves an ordinary act completely alone", async () => {
    const { tools, sent } = build({ secrets: { available: SECRETS } });
    await act(tools, { verb: "type", value: "a search term" });
    expect(sent).toHaveLength(1);
    expect(sent[0].options?.secrets).toBeUndefined();
    expect(sent[0].command.action.value).toBe("a search term");
  });
});

describe("what leaves this process", () => {
  it("sends the value BESIDE the command, never inside it", async () => {
    // The command is echoed onto the ledger row, into `/v1/trace` and into the
    // durable mirror. A value on it would be written to all three before
    // anything could scrub it.
    const { tools, sent } = build({ secrets: { available: SECRETS } });
    await act(tools, { verb: "type", value: "{{secret:GITHUB_PASSWORD}}" });
    expect(sent[0].command.action.value).toBe("{{secret:GITHUB_PASSWORD}}");
    expect(JSON.stringify(sent[0].command)).not.toContain(PASSWORD);
    expect(sent[0].options?.secrets).toEqual(SECRETS);
  });

  it("sends ONLY the names the act references", async () => {
    const { tools, sent } = build({
      secrets: {
        available: [...SECRETS, { name: "OTHER", value: "unrelated-value" }],
      },
    });
    await act(tools, { verb: "type", value: "{{secret:GITHUB_PASSWORD}}" });
    expect(sent[0].options?.secrets?.map((s) => s.name)).toEqual([
      "GITHUB_PASSWORD",
    ]);
  });

  it("reads fill_form fields too", async () => {
    const { tools, sent } = build({ secrets: { available: SECRETS } });
    await act(tools, {
      verb: "fill_form",
      fields: [
        { selector: "#user", value: "alex" },
        { selector: "#pw", value: "{{secret:GITHUB_PASSWORD}}" },
      ],
    });
    expect(sent[0].options?.secrets).toEqual(SECRETS);
    expect(JSON.stringify(sent[0].command)).not.toContain(PASSWORD);
  });

  it("tells the surface which NAMES were delivered, never the values", async () => {
    const delivered: string[][] = [];
    const { tools } = build({
      secrets: {
        available: SECRETS,
        onDelivered: (names: readonly string[]) => delivered.push([...names]),
      },
    });
    await act(tools, { verb: "type", value: "{{secret:GITHUB_PASSWORD}}" });
    expect(delivered).toEqual([["GITHUB_PASSWORD"]]);
  });

  it("records the delivery even when the response never arrives", async () => {
    // THE VALUE LEFT THIS PROCESS the moment the body went out. The callback
    // is read before deleting a credential believed dormant, so a daemon that
    // received the POST and then timed out must not be recorded as never
    // having had it — false "never delivered" is the dangerous direction.
    const delivered: string[][] = [];
    const ensureSession = vi.fn(async () => ({
      engine: "hosted" as const,
      target: "computer" as const,
      sessionId: "session-1",
      computerId: "computer-1",
      bootId: "boot-1",
      client: {
        sendCommand: async () => {
          throw new Error("socket hang up");
        },
        status: async () => ({
          kind: "ok",
          features: ["secret-placeholders"],
        }),
      } as never,
      streamUrl: "https://stream.example/vnc.html",
      streamPassword: "pw",
      contextMode: "persistent" as const,
      reused: true,
    }));
    const result = buildBrowserTools({
      authHeader: "Bearer user",
      projectId: "project-1",
      approvalDelivery: { kind: "attested" },
      ensureSession: ensureSession as never,
      tokenMemory: new BrowserTokenMemory(),
      secrets: {
        available: SECRETS,
        onDelivered: (names: readonly string[]) => delivered.push([...names]),
      },
    });
    await expect(
      act(result!.tools, {
        verb: "type",
        value: "{{secret:GITHUB_PASSWORD}}",
      }),
    ).rejects.toThrow(/socket hang up/);
    expect(delivered).toEqual([["GITHUB_PASSWORD"]]);
  });

  it("does not fire the delivery callback for an ordinary act", async () => {
    const delivered: string[][] = [];
    const { tools } = build({
      secrets: {
        available: SECRETS,
        onDelivered: (names: readonly string[]) => delivered.push([...names]),
      },
    });
    await act(tools, { verb: "type", value: "plain" });
    expect(delivered).toEqual([]);
  });
});

describe("what comes back", () => {
  it("drops the screenshot when a secret was typed", async () => {
    // A picture is not a string: a site that does not mask the field renders
    // the value, and no scrub can take it back out again.
    const { tools, sent } = build({ secrets: { available: SECRETS } });
    await act(tools, {
      verb: "type",
      value: "{{secret:GITHUB_PASSWORD}}",
      observe: "both",
    });
    expect(sent[0].command.action.observe).toBe("a11y");
  });

  it("still observes `both` for an ordinary act", async () => {
    const { tools, sent } = build({ secrets: { available: SECRETS } });
    await act(tools, { verb: "type", value: "plain", observe: "both" });
    expect(sent[0].command.action.observe).toBe("both");
  });

  it("honours an explicit `none` rather than upgrading it", async () => {
    const { tools, sent } = build({ secrets: { available: SECRETS } });
    await act(tools, {
      verb: "type",
      value: "{{secret:GITHUB_PASSWORD}}",
      observe: "none",
    });
    expect(sent[0].command.action.observe).toBe("none");
  });

  it("scrubs a value the PAGE hands back, as a belt to the daemon's braces", async () => {
    // For the cases the daemon's own registry cannot cover: an older build, a
    // relaunch that reset it, or a page that already held the value.
    const { tools } = build({ secrets: { available: SECRETS } }, undefined, () => ({
      ok: true,
      output: { url: "https://x.test", a11y: `textbox "Password": "${PASSWORD}"` },
      stateToken: {
        tabId: "@session",
        navCounter: 1,
        urlHash: "u",
        domHash: "d",
      },
      settled: true,
    }));
    const out = await act(tools, { verb: "click", ref: "e1" });
    expect(JSON.stringify(out)).not.toContain(PASSWORD);
    expect(JSON.stringify(out)).toContain("{{secret:GITHUB_PASSWORD}}");
  });

  it("does not scrub anything when the turn has no secrets", async () => {
    const { tools } = build(undefined, undefined, () => ({
      ok: true,
      output: { url: "https://x.test", a11y: `textbox: "${PASSWORD}"` },
      stateToken: {
        tabId: "@session",
        navCounter: 1,
        urlHash: "u",
        domHash: "d",
      },
      settled: true,
    }));
    expect(JSON.stringify(await act(tools, { verb: "click", ref: "e1" }))).toContain(
      PASSWORD,
    );
  });
});
