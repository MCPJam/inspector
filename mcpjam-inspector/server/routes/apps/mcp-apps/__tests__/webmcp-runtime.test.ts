import { afterEach, describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import { WEBMCP_VIEW_POLYFILL_JS } from "../webmcp-view-polyfill.js";
import { WEBMCP_RELAY_SOURCE } from "../webmcp-relay-source.js";

const doms: JSDOM[] = [];
function realm(source: string) {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://app.example",
    runScripts: "outside-only",
    beforeParse(window) {
      window.TextEncoder = TextEncoder;
    },
  });
  doms.push(dom);
  dom.window.eval(source);
  return dom.window;
}
afterEach(() => {
  for (const dom of doms.splice(0)) dom.window.close();
  vi.useRealTimers();
});

describe("WebMCP view runtime", () => {
  it("shadows native, clones inputs, unregisters and serializes returns", async () => {
    const w = realm(WEBMCP_VIEW_POLYFILL_JS);
    expect(
      await w.eval(`(async () => {
      const ac = new AbortController();
      await document.modelContext.registerTool({name:'move',description:'Move',execute: x => ({move:x.move})},{signal:ac.signal});
      const tools = await document.modelContext.getTools();
      const result = await document.modelContext.executeTool(tools[0],{move:'e4'});
      ac.abort();
      return {result,count:(await document.modelContext.getTools()).length};
    })()`),
    ).toEqual({ result: '{"move":"e4"}', count: 0 });
  });

  it("rejects duplicate registration and invalid schemas", async () => {
    const w = realm(WEBMCP_VIEW_POLYFILL_JS);
    await expect(
      w.eval(`(async () => {
      const tool={name:'x',description:'x',execute:()=>null};
      await document.modelContext.registerTool(tool);
      await document.modelContext.registerTool(tool);
    })()`),
    ).rejects.toThrow("Duplicate");
    await expect(
      w.eval(
        `document.modelContext.registerTool({name:'array',description:'x',inputSchema:{type:'array'},execute:()=>null})`,
      ),
    ).rejects.toThrow("Invalid");
  });

  it("settles abort even when the handler ignores its signal", async () => {
    const w = realm(WEBMCP_VIEW_POLYFILL_JS);
    await expect(
      w.eval(`(async () => {
      await document.modelContext.registerTool({name:'wait',description:'Wait',execute:()=>new Promise(()=>{})});
      const ac=new AbortController();
      const promise=document.modelContext.executeTool({name:'wait'},{},{signal:ac.signal});
      ac.abort(new Error('stopped'));
      return promise;
    })()`),
    ).rejects.toThrow("stopped");
  });

  it.each(["'é'.repeat(150000)", "1n", "(()=>{const x={};x.x=x;return x;})()"])(
    "bounds or rejects result %s",
    async (value) => {
      const w = realm(WEBMCP_VIEW_POLYFILL_JS);
      await expect(
        w.eval(`(async () => {
      await document.modelContext.registerTool({name:'large',description:'Large',execute:()=>${value}});
      return document.modelContext.executeTool({name:'large'});
    })()`),
      ).rejects.toThrow();
    },
  );
});

describe("WebMCP relay", () => {
  function harness() {
    const w = realm(
      WEBMCP_RELAY_SOURCE +
        `
      const sent=[],posted=[];
      const relay=createWebmcpRelay({send:x=>sent.push(x),post:x=>posted.push(x),live:()=>true});
      globalThis.h={relay,sent,posted};
    `,
    );
    return w;
  }

  it("keeps disabled and legacy traffic separate", () => {
    const w = harness();
    expect(w.eval(`h.relay.host({id:1,method:'ui/sandbox-list-tools'})`)).toBe(
      true,
    );
    expect(w.eval(`h.posted[0].error.code`)).toBe(-32601);
    expect(w.eval(`h.relay.host({id:2,method:'tools/list'})`)).toBe(false);
    expect(w.eval(`h.sent.length`)).toBe(0);
  });

  it("correlates results, rejects stale replies, and clears on remount", () => {
    const w = harness();
    w.eval(
      `h.relay.configure(true);h.relay.host({id:1,method:'ui/sandbox-list-tools'});`,
    );
    w.eval(
      `h.relay.view({type:'mcpjam:webmcp/list-result',requestId:h.sent[0].requestId,tools:[{name:'move',description:'Move'}]});`,
    );
    expect(w.eval(`h.posted[0].result.tools[0].name`)).toBe("move");
    w.eval(
      `h.relay.host({id:2,method:'ui/sandbox-call-tool',params:{name:'move'}});h.relay.reset();`,
    );
    expect(w.eval(`h.posted[1].error.code`)).toBe(-32603);
    w.eval(
      `h.relay.view({type:'mcpjam:webmcp/call-result',requestId:h.sent[1].requestId,ok:true,value:'late'});`,
    );
    expect(w.eval(`h.posted.length`)).toBe(3);
  });

  it("cancels only its own request and sends no legacy cancellation", () => {
    const w = harness();
    w.eval(
      `h.relay.configure(true);h.relay.host({id:1,method:'ui/sandbox-list-tools'});`,
    );
    expect(
      w.eval(
        `h.relay.host({method:'notifications/cancelled',params:{requestId:99}})`,
      ),
    ).toBe(false);
    expect(
      w.eval(
        `h.relay.host({method:'notifications/cancelled',params:{requestId:1}})`,
      ),
    ).toBe(true);
    expect(w.eval(`h.sent[1].type`)).toBe("mcpjam:webmcp/cancel");
    expect(w.eval(`h.posted[0].error.code`)).toBe(-32800);
  });

  it("bounds list timeouts and coalesces change notifications", () => {
    vi.useFakeTimers();
    const w = harness();
    w.eval(
      `h.relay.configure(true);h.relay.host({id:1,method:'ui/sandbox-list-tools'});`,
    );
    w.eval(
      `for(let i=0;i<100;i++)h.relay.view({type:'mcpjam:webmcp/tools-changed'});`,
    );
    vi.advanceTimersByTime(250);
    expect(w.eval(`h.posted.length`)).toBe(1);
    vi.advanceTimersByTime(9750);
    expect(w.eval(`h.posted[1].error.message`)).toContain("timed out");
    w.eval(`h.relay.reset()`);
    expect(w.eval(`h.posted.length`)).toBe(2);
  });

  it("does not announce an empty legacy mount reset", () => {
    const w = harness();
    w.eval(`h.relay.reset()`);
    expect(w.eval(`h.posted`)).toEqual([]);
  });

  it("drops malformed descriptors instead of changing their schema type", () => {
    const w = harness();
    w.eval(`h.relay.configure(true);h.relay.host({id:1,method:'ui/sandbox-list-tools'});
      h.relay.view({type:'mcpjam:webmcp/list-result',requestId:h.sent[0].requestId,tools:[
        {name:'array',description:'Invalid',inputSchema:{type:'array'}},
        {name:'valid',description:'Valid',inputSchema:{type:'object'}}
      ]});`);
    expect(w.eval(`h.posted[0].result.tools.map(x=>x.name)`)).toEqual([
      "valid",
    ]);
  });
});
