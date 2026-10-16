import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { RECORDER_SHIM_JS } from "../recorder-shim";
import { McpAppBrowserHarness } from "../../../../utils/mcp-app-browser-harness";
import type { InteractAction, TestStep } from "@/shared/steps";

type HostWindow = Window & {
  recordingHost: {
    steps: TestStep[];
    picked: unknown;
    mode: (mode: string) => void;
    stop: () => Promise<void>;
    replay: (step: unknown) => Promise<{ ok: boolean }>;
    disable: () => void;
    late: () => void;
  };
  guestHtml: string;
  proxyHtml: string;
};
let browser: Browser;
let page: Page;
let hostScript: string;
let bridgeScript: string;
const root = path.resolve(process.cwd(), "..");
const proxyHtml = readFileSync(
  new URL("../sandbox-proxy.html", import.meta.url),
  "utf8",
)
  .replace('"__MCPJAM_RECORDER_SHIM__"', () => JSON.stringify(RECORDER_SHIM_JS))
  .replace('"__MCPJAM_HOST_ORIGINS__"', '["http://localhost:*"]');

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  const host = await build({
    stdin: {
      contents: `
    import React, {useState,useRef,useEffect} from 'react';
    import {createRoot} from 'react-dom/client';
    import {useEvalRecorder} from '${root}/mcpjam-inspector/client/src/components/evals/use-eval-recorder';
    import {useWidgetRecorder} from '${root}/widget-react/src/use-widget-recorder';
    function Host(){
      const [form,setForm]=useState({steps:[{id:'prompt',kind:'prompt',prompt:'Q'}]});
      const [active,setActive]=useState(true);const [enabled,setEnabled]=useState(true);const [mode,setMode]=useState('record');
      const frame=useRef(null);const liveReplay=useRef(null);
      const {recorder,pendingPick,stopRecording}=useEvalRecorder({enabled,active,mode,onStop:()=>setActive(false),caseId:'case',setForm});
      const sandbox=useRef({postMessage:data=>frame.current?.contentWindow?.postMessage(data,'*'),getIframeElement:()=>frame.current});
      const {handleRecorderMessage}=useWidgetRecorder({sandbox,capable:enabled,mode:recorder?.recorderCaptureMode,
        onStep:(step,captureId)=>recorder?.onRecorderStep?.({step,captureId,promptIndex:0,toolName:'view',toolCallId:'call'}),
        onReplayReady:replay=>{liveReplay.current=replay},
        onFlushReady:flush=>recorder?.onRecorderFlushReady?.({toolCallId:'call',flush}),
        onPick:target=>recorder?.onRecorderPick?.({target,promptIndex:0,toolName:'view',toolCallId:'call'})});
      const old=useRef(recorder);
      window.recordingHost={steps:form.steps,picked:pendingPick,mode:setMode,replay:step=>liveReplay.current(step),stop:stopRecording,disable:()=>setEnabled(false),late:()=>old.current.onRecorderStep({promptIndex:0,toolName:'view',toolCallId:'call',captureId:'late',step:{kind:'click',target:{testId:'late'}}})};
      useEffect(()=>{const receive=event=>{
        if(event.source!==frame.current?.contentWindow)return;
        if(event.data?.method==='ui/notifications/sandbox-proxy-ready')sandbox.current.postMessage({jsonrpc:'2.0',method:'ui/notifications/sandbox-resource-ready',params:{html:window.guestHtml,recordMode:true,permissive:true}});
        else handleRecorderMessage(event.data);
      };window.addEventListener('message',receive);return()=>window.removeEventListener('message',receive)},[handleRecorderMessage]);
      return <iframe id="guest" ref={frame} srcDoc={window.proxyHtml} style={{width:900,height:800}}/>;
    }createRoot(document.getElementById('root')).render(<Host/>);
  `,
      resolveDir: root,
      loader: "tsx",
    },
    tsconfig: path.join(root, "mcpjam-inspector/client/tsconfig.json"),
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    write: false,
    logLevel: "silent",
  });
  hostScript = host.outputFiles[0].text;
  const bridge = await build({
    stdin: {
      contents: `import {App} from '@modelcontextprotocol/ext-apps';new App({name:'recording-fixture',version:'1'}).connect();`,
      resolveDir: root,
      loader: "ts",
    },
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    write: false,
    logLevel: "silent",
  });
  bridgeScript = bridge.outputFiles[0].text;
}, 60_000);
afterEach(async () => {
  await page?.close();
});
afterAll(async () => {
  await browser?.close();
});

async function setup(html: string) {
  page = await browser.newPage();
  await page.route("http://localhost:5173/recording-fixture", (route) =>
    route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }),
  );
  await page.goto("http://localhost:5173/recording-fixture");
  await page.evaluate(
    ({ html, proxy }) => {
      (window as HostWindow).guestHtml = html;
      (window as HostWindow).proxyHtml = proxy;
    },
    { html, proxy: proxyHtml },
  );
  await page.addScriptTag({ content: hostScript });
  await page
    .frameLocator("#guest")
    .frameLocator("iframe")
    .locator("body")
    .waitFor();
  await page.waitForTimeout(300);
  return page.frameLocator("#guest").frameLocator("iframe");
}

async function actions(): Promise<InteractAction[]> {
  await page.waitForTimeout(50);
  return page.evaluate(() =>
    (window as HostWindow).recordingHost.steps.flatMap((step) =>
      step.kind === "interact" ? [step.action] : [],
    ),
  );
}

async function replay(
  html: string,
  steps: InteractAction[],
  assertions: Array<{ target: { testId: string }; equals: string }> = [],
) {
  const harness = new McpAppBrowserHarness({
    callTool: async () => ({ content: [] }),
    budgets: {
      maxBrowserStepsPerWidget: 100,
      totalScreenshotsPerIteration: 100,
      settleTimeoutMs: 300,
    },
  });
  try {
    const rendered = await harness.renderWidget({
      toolCallId: "replay",
      toolName: "view",
      serverId: "fixture",
      html: `<html><head><script>${bridgeScript}</script></head><body>${html}</body></html>`,
      keepMounted: true,
    });
    expect(rendered.status).toBe("rendered");
    for (const step of steps) {
      const result = await harness.runScriptedStep({
        toolCallId: "replay",
        step,
      });
      expect(result.ok, result.reason).toBe(true);
    }
    for (const assertion of assertions) {
      const result = await harness.runScriptedStep({
        toolCallId: "replay",
        step: {
          kind: "assert",
          assertion: { type: "inputValue", ...assertion },
        },
      });
      expect(result.ok, result.reason).toBe(true);
    }
  } finally {
    await harness.dispose();
  }
}

describe("recording through the sandbox and real save callback", () => {
  it("saves all 20 blur-and-click actions in order and replays their final state", async () => {
    const html = `<input id="query" data-testid="query"><input type="hidden" id="submitted" data-testid="submitted"><button data-testid="go" onclick="document.getElementById('submitted').value=document.getElementById('query').value;document.getElementById('query').value=''">Go</button>`;
    const guest = await setup(html);
    for (let i = 0; i < 10; i++) {
      await guest.getByTestId("query").fill("repeated value");
      await guest.getByTestId("go").click();
    }
    const saved = await actions();
    expect(saved).toHaveLength(20);
    expect(saved.map((step) => step.kind)).toEqual(
      Array.from({ length: 10 }, () => ["type", "click"]).flat(),
    );
    await replay(html, saved, [
      { target: { testId: "submitted" }, equals: "repeated value" },
    ]);
  }, 60_000);

  it("coalesces typing and paste and keeps the final value when stopped", async () => {
    const html = '<input data-testid="query">';
    const guest = await setup(html);
    await guest.getByTestId("query").pressSequentially("hello");
    await guest.getByTestId("query").press("ControlOrMeta+A");
    await page
      .context()
      .grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.evaluate(() => navigator.clipboard.writeText("pasted text"));
    await guest.getByTestId("query").press("ControlOrMeta+V");
    await page.evaluate(() => (window as HostWindow).recordingHost.stop());
    expect(await actions()).toEqual([
      { kind: "type", target: { testId: "query" }, text: "pasted text" },
    ]);
  });

  it("keeps committed composition text", async () => {
    const guest = await setup('<input data-testid="query">');
    await guest.getByTestId("query").focus();
    const session = await page.context().newCDPSession(page);
    await session.send("Input.imeSetComposition", {
      text: "漢",
      selectionStart: 1,
      selectionEnd: 1,
    });
    await session.send("Input.insertText", { text: "漢字" });
    const saved = await actions();
    expect(saved).toEqual([
      { kind: "type", target: { testId: "query" }, text: "漢字" },
    ]);
    await session.detach();
  });

  it("records checkboxes, radios and native dropdowns as valid replayable actions", async () => {
    const html =
      '<label for="agree">Agree</label><input id="agree" type="checkbox" data-testid="agree"><label for="choice">Choice</label><input id="choice" type="radio" data-testid="choice"><select data-testid="plan"><option value="free">Free</option><option value="pro">Pro</option></select>';
    const guest = await setup(html);
    await guest.getByText("Agree").click();
    await guest.getByText("Choice").click();
    await guest.getByTestId("plan").focus();
    await guest.getByTestId("plan").press("p");
    expect(await guest.getByTestId("plan").inputValue()).toBe("pro");
    const saved = await actions();
    expect(saved.map((step) => step.kind)).toEqual([
      "click",
      "click",
      "select",
    ]);
    expect(saved[2]).toEqual({
      kind: "select",
      target: { testId: "plan" },
      values: ["pro"],
    });
    await replay(html, saved, [{ target: { testId: "plan" }, equals: "pro" }]);
  });

  it("corrects double clicks and records right clicks", async () => {
    const html = '<button data-testid="go">Go</button>';
    const guest = await setup(html);
    await guest.getByTestId("go").dblclick();
    await guest.getByTestId("go").click({ button: "right" });
    const saved = await actions();
    expect(saved).toEqual([
      { kind: "click", target: { testId: "go" }, clickType: "double" },
      { kind: "click", target: { testId: "go" }, clickType: "right" },
    ]);
    await replay(html, saved);
  });

  it("replays duplicate buttons, labelled inputs and decorative icon buttons", async () => {
    const html =
      '<button>Save</button><button>Save</button><label for="q">Search</label><input id="q"><input aria-label="Other"><button><span aria-hidden="true">+</span> Add</button>';
    const guest = await setup(html);
    await guest.getByRole("button", { name: "Save" }).nth(0).click();
    await guest.getByRole("button", { name: "Save" }).nth(1).click();
    await guest.locator("#q").fill("value");
    await guest.getByRole("button", { name: "Add" }).click();
    await replay(html, await actions());
  });

  it("records targeted keys and nested scrolling", async () => {
    const html = `<input data-testid="query" onkeydown="if(event.ctrlKey && event.shiftKey && event.key===String.fromCharCode(43)){document.getElementById('shortcut').value='plus';event.preventDefault()}"><input id="shortcut" type="hidden" data-testid="shortcut"><button data-testid="next">Next</button><div data-testid="scroll" style="height:80px;overflow:auto"><div style="height:600px">Content</div></div>`;
    const guest = await setup(html);
    await guest.getByTestId("query").fill("value");
    await guest.getByTestId("query").press("Control+Shift+Equal");
    await guest.getByTestId("query").press("Enter");
    await guest.getByTestId("query").press("Tab");
    await guest.getByTestId("scroll").hover();
    await page.mouse.wheel(0, 250);
    await page.waitForTimeout(400);
    const saved = await actions();
    expect(
      saved.filter((step) => step.kind === "key").map((step) => step.key),
    ).toEqual(["Control+Shift+Equal", "Enter", "Tab"]);
    expect(
      saved.some(
        (step) =>
          step.kind === "scrollTo" &&
          step.y > 0 &&
          step.target.testId === "scroll",
      ),
    ).toBe(true);
    await page.mouse.wheel(0, 50);
    await page.waitForTimeout(400);
    const separateGestures = await actions();
    expect(
      separateGestures.filter((step) => step.kind === "scrollTo"),
    ).toHaveLength(2);
    await replay(html, separateGestures, [
      { target: { testId: "shortcut" }, equals: "plus" },
    ]);
  });

  it("records the exact document scroll position", async () => {
    const html =
      '<button data-testid="go">Go</button><input type="hidden" data-testid="position"><div style="height:5000px">Content</div><script>window.addEventListener("scroll",()=>document.querySelector("input").value=String(window.scrollY));</script>';
    const guest = await setup(html);
    await guest.getByTestId("go").click();
    await page.mouse.wheel(0, 300);
    await page.waitForTimeout(400);
    const saved = await actions();
    const scroll = saved.find((step) => step.kind === "scrollTo");
    expect(scroll).toMatchObject({
      kind: "scrollTo",
      target: { css: "html" },
      x: 0,
    });
    expect(scroll?.kind === "scrollTo" && scroll.y > 0).toBe(true);
    if (scroll?.kind === "scrollTo")
      await replay(html, saved, [
        { target: { testId: "position" }, equals: String(scroll.y) },
      ]);
  });

  it("picks an assertion without clicking the real button or remounting", async () => {
    const guest = await setup(
      '<button data-testid="delete" onclick="this.remove()">Delete</button><script>window.addEventListener("pointerdown",()=>document.querySelector("button")?.remove(),true)</script>',
    );
    const initialFrames = page.frames().map((frame) => frame.url());
    await guest.locator("body").evaluate((body) => {
      body.dataset.instance = "survives-mode-change";
    });
    await page.evaluate(() =>
      (window as HostWindow).recordingHost.mode("assert"),
    );
    await page.waitForTimeout(50);
    await guest.getByTestId("delete").click();
    expect(await guest.getByTestId("delete").count()).toBe(1);
    expect(await actions()).toEqual([]);
    expect(
      await page.evaluate(() => (window as HostWindow).recordingHost.picked),
    ).toMatchObject({ locator: { testId: "delete" } });
    expect(page.frames().map((frame) => frame.url())).toEqual(initialFrames);
    expect(await guest.locator("body").getAttribute("data-instance")).toBe(
      "survives-mode-change",
    );
  });

  it.each(["stop", "disable"] as const)(
    "ignores late captures after %s",
    async (method) => {
      const guest = await setup('<button data-testid="go">Go</button>');
      await page.evaluate((method) => {
        (window as HostWindow).recordingHost[method]();
      }, method);
      await page.waitForTimeout(50);
      await guest.getByTestId("go").click();
      await page.evaluate(() => (window as HostWindow).recordingHost.late());
      expect(await actions()).toEqual([]);
    },
  );

  it("replays new actions in the guest without capturing replay events", async () => {
    const guest = await setup(
      `<input data-testid="query" onkeydown="if(event.ctrlKey && event.key==='Enter')this.value='keyed'"><select data-testid="plan"><option>free</option><option>pro</option></select><div data-testid="scroll" style="height:80px;overflow:auto"><div style="height:600px">Content</div></div>`,
    );
    await guest.getByTestId("query").fill("seed");
    expect(await actions()).toHaveLength(1);
    const results = await page.evaluate(async () => {
      const host = (window as HostWindow).recordingHost;
      const steps = [
        { kind: "select", target: { testId: "plan" }, values: ["pro"] },
        { kind: "key", target: { testId: "query" }, key: "Control+Enter" },
        { kind: "scrollTo", target: { testId: "scroll" }, x: 0, y: 200 },
      ];
      const results = [];
      for (const step of steps) results.push(await host.replay(step));
      return results;
    });
    expect(results.every((result) => result.ok)).toBe(true);
    expect(await guest.getByTestId("plan").inputValue()).toBe("pro");
    expect(await guest.getByTestId("query").inputValue()).toBe("keyed");
    expect(
      await guest.getByTestId("scroll").evaluate((el) => el.scrollTop),
    ).toBe(200);
    expect(await actions()).toHaveLength(1);
  });
});
