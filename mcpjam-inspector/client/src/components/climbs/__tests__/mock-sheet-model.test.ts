import { describe, expect, it } from "vitest";
import {
  addCase,
  applyDrafts,
  checkDefinition,
  describeCase,
  initialDraft,
  isStaleSave,
  parseCaseRow,
  parseWhenValue,
  realTools,
  removeCase,
  schemaOf,
  toolNames,
  whenValueText,
} from "../mock-sheet-model";

const real = { get_run: { description: "Gets a run.", inputSchema: { type: "object" } }, list_runs: { description: "Lists runs." } };

describe("tool list and drafts", () => {
  it("lists the real tools, then the added ones, and leaves out hidden ones", () => {
    const definition = { tools: { extra: { description: "Added." }, list_runs: { hidden: true as const } } };
    expect(toolNames(definition, real)).toEqual(["get_run", "extra"]);
  });
  it("reads real tools from what can change, filling in from the edited entries", () => {
    const where = (tool: string, field: string) => ({ kind: "tool" as const, tool, field, mockPath: "" });
    const tools = realTools({
      whatCanChange: [{ where: where("a", "description"), current: "A." } as never],
      realServer: { status: "read", tools: [{ tool: "b", realTool: "b", found: true, current: { description: "B." } }] },
    });
    expect(tools).toEqual({ a: { description: "A." }, b: { description: "B.", inputSchema: undefined } });
  });
  it("starts from the entry's own values, else the real ones", () => {
    expect(initialDraft({}, "get_run", real.get_run).description).toBe("Gets a run.");
    const draft = initialDraft({ tools: { get_run: { description: "Mine.", answer: { from: "model", instructions: "Short." } } } }, "get_run", real.get_run);
    expect(draft).toMatchObject({ description: "Mine.", answering: "model", instructions: "Short." });
  });
  it("says whether the schema is the mock's own", () => {
    expect(schemaOf({}, "get_run", real.get_run)).toEqual({ schema: { type: "object" }, edited: false });
    expect(schemaOf({ tools: { get_run: { inputSchema: { type: "object", properties: {} } } } }, "get_run", real.get_run).edited).toBe(true);
  });
});

describe("applyDrafts", () => {
  it("sets a changed description and leaves other tools as they were", () => {
    const definition = { tools: { list_runs: { title: "Runs" } } };
    const draft = { ...initialDraft(definition, "get_run", real.get_run), description: "Gets one run." };
    const result = applyDrafts(definition, { get_run: draft }, real);
    expect(result).toEqual({ ok: true, value: { tools: { list_runs: { title: "Runs" }, get_run: { description: "Gets one run." } } } });
  });
  it("drops the description and the entry when the text goes back to the real one", () => {
    const definition = { tools: { get_run: { description: "Mine." } } };
    const draft = { ...initialDraft(definition, "get_run", real.get_run), description: "Gets a run." };
    expect(applyDrafts(definition, { get_run: draft }, real)).toEqual({ ok: true, value: {} });
  });
  it("keeps a real-tool answer when the tool answers from the server", () => {
    const definition = { tools: { get_run: { answer: { tool: "fetch_run" } } } };
    const draft = initialDraft(definition, "get_run", real.get_run);
    expect(applyDrafts(definition, { get_run: draft }, real)).toEqual({ ok: true, value: definition });
  });
  it("switches from saved answers back to the server", () => {
    const definition = { tools: { get_run: { answer: { from: "saved" as const, cases: [{ result: { content: [] } }] } } } };
    const draft = { ...initialDraft(definition, "get_run", real.get_run), answering: "server" as const };
    expect(applyDrafts(definition, { get_run: draft }, real)).toEqual({ ok: true, value: {} });
  });
  it("builds saved answers from stored and written cases, in order", () => {
    const definition = { tools: { get_run: { answer: { from: "saved" as const, cases: [{ error: { code: 1, message: "No." } }] } } } };
    let draft = addCase(initialDraft(definition, "get_run", real.get_run));
    draft = { ...draft, rows: [draft.rows[0], { ...(draft.rows[1] as object), whenKey: "id", whenValue: "7", resultText: '{"content":[]}' } as never] };
    const result = applyDrafts(definition, { get_run: draft }, real);
    expect(result).toEqual({
      ok: true,
      value: { tools: { get_run: { answer: { from: "saved", cases: [{ error: { code: 1, message: "No." } }, { when: { id: 7 }, result: { content: [] } }] } } } },
    });
  });
  it("names the tool and case whose result is not readable", () => {
    const draft = { ...addCase({ ...initialDraft({}, "get_run", real.get_run), answering: "saved" as const }) };
    const result = applyDrafts({}, { get_run: draft }, real);
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("get_run, case 1") });
  });
  it("leaves out empty model instructions", () => {
    const draft = { ...initialDraft({}, "get_run", real.get_run), answering: "model" as const, instructions: "  " };
    expect(applyDrafts({}, { get_run: draft }, real)).toEqual({ ok: true, value: { tools: { get_run: { answer: { from: "model" } } } } });
  });
});

describe("cases", () => {
  const row = (over: object) => ({ id: "n", kind: "new" as const, whenKey: "", whenValue: "", resultText: "{}", ...over });
  it("reads a typed value as JSON when it parses and as text when it does not", () => {
    expect(parseWhenValue("41")).toBe(41);
    expect(parseWhenValue("true")).toBe(true);
    expect(parseWhenValue('"41"')).toBe("41");
    expect(parseWhenValue(" run_41 ")).toBe("run_41");
  });
  it("shows a value so it reads back the same", () => {
    expect(whenValueText("run_41")).toBe("run_41");
    expect(whenValueText("41")).toBe('"41"');
    expect(whenValueText(41)).toBe("41");
  });
  it("matches any call with no key, and asks for a value when there is a key", () => {
    expect(parseCaseRow(row({}))).toEqual({ ok: true, value: { result: {} } });
    expect(parseCaseRow(row({ whenKey: "id" }))).toMatchObject({ ok: false, error: expect.stringContaining('"id"') });
  });
  it("wants a JSON object for the result", () => {
    expect(parseCaseRow(row({ resultText: "[1]" }))).toMatchObject({ ok: false });
    expect(parseCaseRow(row({ resultText: "" }))).toMatchObject({ ok: false, error: expect.stringContaining("not valid JSON") });
  });
  it("describes stored cases and stops adding at the cap", () => {
    expect(describeCase({ when: { a: 1, b: "x" }, result: {} }).when).toBe("a is 1 and b is x");
    let draft = initialDraft({}, "t", undefined);
    for (let i = 0; i < 205; i++) draft = addCase(draft);
    expect(draft.rows).toHaveLength(200);
    expect(removeCase(draft, "new-0").rows).toHaveLength(199);
  });
});

describe("checks", () => {
  it("reports the first issue's message and how many more", () => {
    const result = checkDefinition({ tools: { a: { answer: { from: "saved", cases: [] } }, b: { description: 3 as never } } });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("at least one case") });
  });
  it("knows a stale save by its code", () => {
    expect(isStaleSave(Object.assign(new Error("x"), { code: "MOCK_VERSION_STALE" }))).toBe(true);
    expect(isStaleSave(new Error("x"))).toBe(false);
    expect(isStaleSave(undefined)).toBe(false);
  });
});
