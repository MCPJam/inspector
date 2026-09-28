/**
 * THE THIRTEEN SURFACES THAT HAVE TO AGREE ABOUT A BROWSER ACT VERB.
 *
 * `shared/browser-agent-contract.ts` is the public contract, and the SDK ships
 * a HAND-MAINTAINED COPY of it — `shared/` is the inspector's own module graph
 * and the published SDK cannot import across the workspace, so the file is
 * duplicated on purpose. Nothing checked that the duplicate was still the same
 * file, and nothing checked that a verb reaching one surface reached the rest.
 *
 * The cost of that gap is on record. `fill_form` was added to the daemon, is
 * dispatched by the driver, is offered to the model — and is absent from the
 * contract, the `/v1` request schema, the SDK's allowlist, the OpenAPI enum and
 * the CLI's `--verb` help. It compiled, because `publishedOpFor` switches on
 * `action.kind` (`act`) and never on the verb, so the exhaustive mapper that
 * exists precisely to force the publish decision never saw a decision to make.
 *
 * So this file walks the lists instead of trusting the types:
 *
 *   1. the SDK's copy of the contract is byte-identical to `shared/`'s;
 *   2. every PUBLISHED verb is accepted by the daemon, the `/v1` schema, the
 *      SDK allowlist and the OpenAPI enum;
 *   3. the daemon's extra verbs are EXACTLY the documented daemon-only set;
 *   4. the model tool's verbs are the contract's, minus the tab verbs, plus
 *      the daemon-only set;
 *   5. the CLI's `--verb` help names every published verb.
 *
 * A new daemon verb now fails (3) until someone writes it into
 * `DAEMON_ONLY_ACT_VERBS` (stays private) or into `BROWSER_AGENT_ACT_VERBS`
 * (becomes public, and then (2) and (5) name every file still to update).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BROWSER_AGENT_ACT_VERBS } from "../browser-agent-contract";
import { BROWSERD_ACT_VERBS } from "../../server/services/browserd/protocol";
import { DAEMON_ONLY_ACT_VERBS } from "../../server/services/browserd/agent-contract-mapper";

/** `mcpjam-inspector/` — the inspector app. */
const APP = resolve(__dirname, "..", "..");
/** The workspace root, where the SDK, the CLI and the docs live. */
const ROOT = resolve(APP, "..");

const read = (path: string) => readFileSync(path, "utf8");

/**
 * Pull an `as const` array of string literals out of a source file.
 *
 * Reading the SOURCE rather than importing the module, for one surface only:
 * `server/utils/built-in-tools/browser.ts` is the model's tool definition and
 * drags the AI SDK, the config module and a Convex client in behind it, none of
 * which a `shared/` unit test should be booting to learn what ten strings are.
 * The literal it reads is the literal `z.enum` is handed, which is the property
 * under test.
 */
function readStringListConst(source: string, name: string): string[] {
  const start = source.indexOf(`export const ${name} = [`);
  expect(
    start,
    `${name} should be an exported array literal`,
  ).toBeGreaterThanOrEqual(0);
  const end = source.indexOf("] as const;", start);
  expect(end, `${name} should end with "] as const;"`).toBeGreaterThan(start);
  const body = source.slice(start + `export const ${name} = [`.length, end);
  return [...body.matchAll(/"([^"]+)"/g)].map((match) => match[1]!);
}

describe("the SDK's copy of the browser agent contract", () => {
  it("is byte-identical to the shared one", () => {
    const shared = read(resolve(APP, "shared/browser-agent-contract.ts"));
    const sdk = read(resolve(ROOT, "sdk/src/platform/browser-agent-contract.ts"));
    // Byte-identical, not merely equivalent: the two are edited by hand and the
    // only cheap way to keep a hand-maintained duplicate honest is to forbid
    // any difference at all, formatting included. `cp` is the fix.
    expect(sdk).toBe(shared);
  });
});

describe("every published act verb", () => {
  it("is a verb the daemon dispatches", () => {
    for (const verb of BROWSER_AGENT_ACT_VERBS) {
      expect(
        BROWSERD_ACT_VERBS as readonly string[],
        `the daemon must be able to run published verb "${verb}"`,
      ).toContain(verb);
    }
  });

  it("is accepted by the /v1 request schema", () => {
    // The schema derives its enum from the same list, so this asserts the
    // DERIVATION is still in place rather than re-asserting the list.
    const schema = read(
      resolve(APP, "server/routes/v1/chat-session-browser-command-schema.ts"),
    );
    expect(schema).toContain("z.enum(BROWSER_AGENT_ACT_VERBS)");
    expect(schema).toContain(
      'import { BROWSER_AGENT_ACT_VERBS } from "@/shared/browser-agent-contract";',
    );
  });

  it("is accepted by the SDK's operation allowlist", () => {
    const operations = read(resolve(ROOT, "sdk/src/platform/operations.ts"));
    expect(operations).toContain("BROWSER_AGENT_ACT_VERBS as readonly string[]");
    expect(operations).toContain(
      'import { BROWSER_AGENT_ACT_VERBS } from "./browser-agent-contract.js";',
    );
  });

  it("is in the OpenAPI act enum, which is generated by hand", () => {
    const doc = JSON.parse(
      read(resolve(ROOT, "docs/reference/openapi.json")),
    ) as {
      components: {
        schemas: {
          BrowserAgentCommand: {
            oneOf: Array<{
              properties?: { op?: { const?: string }; verb?: { enum?: string[] } };
            }>;
          };
        };
      };
    };
    const act = doc.components.schemas.BrowserAgentCommand.oneOf.find(
      (member) => member.properties?.op?.const === "act",
    );
    expect(act?.properties?.verb?.enum).toEqual([...BROWSER_AGENT_ACT_VERBS]);
  });
});

describe("the daemon's own verb list", () => {
  it("has exactly the documented daemon-only verbs beyond the contract's", () => {
    const extra = (BROWSERD_ACT_VERBS as readonly string[]).filter(
      (verb) => !(BROWSER_AGENT_ACT_VERBS as readonly string[]).includes(verb),
    );
    // THE PUBLISH DECISION, made visible. A new daemon verb lands here until
    // someone writes it into `DAEMON_ONLY_ACT_VERBS` (deliberately private) or
    // into `BROWSER_AGENT_ACT_VERBS` (published, with the four surfaces above
    // and the CLI help to update alongside it).
    expect(extra).toEqual([...DAEMON_ONLY_ACT_VERBS]);
  });
});

describe("the model's browser_act tool", () => {
  it("offers the contract's verbs, minus the tab verbs, plus the daemon-only set", () => {
    const source = read(resolve(APP, "server/utils/built-in-tools/browser.ts"));
    const offered = readStringListConst(source, "BROWSER_ACT_TOOL_VERBS");
    const withheld = readStringListConst(source, "MODEL_WITHHELD_ACT_VERBS");
    const expected = [
      ...BROWSER_AGENT_ACT_VERBS.filter((verb) => !withheld.includes(verb)),
      ...DAEMON_ONLY_ACT_VERBS,
    ];
    // Order-insensitive: the tool's list is grouped for a reader (`fill_form`
    // sits beside `select`, not after the dialog verbs), and a reordering is
    // not a contract change.
    expect([...offered].sort()).toEqual([...expected].sort());
  });

  it("hands that list straight to zod rather than restating it", () => {
    const source = read(resolve(APP, "server/utils/built-in-tools/browser.ts"));
    expect(source).toContain("verb: z.enum(BROWSER_ACT_TOOL_VERBS)");
  });

  it("withholds only the tab verbs, which are published but ride tabId instead", () => {
    const source = read(resolve(APP, "server/utils/built-in-tools/browser.ts"));
    const withheld = readStringListConst(source, "MODEL_WITHHELD_ACT_VERBS");
    expect(withheld).toEqual(["close_tab", "activate_tab"]);
    for (const verb of withheld) {
      expect(BROWSER_AGENT_ACT_VERBS as readonly string[]).toContain(verb);
    }
  });
});

describe("the CLI's --verb help", () => {
  it("names every published verb", () => {
    const source = read(resolve(ROOT, "cli/src/commands/browser.ts"));
    const help = source.match(/"--verb <verb>",\s*\n?\s*"([^"]+)"/);
    expect(help, "the act command should document its verbs").not.toBeNull();
    const named = help![1]!.split("|").map((verb) => verb.trim());
    expect([...named].sort()).toEqual([...BROWSER_AGENT_ACT_VERBS].sort());
  });
});
