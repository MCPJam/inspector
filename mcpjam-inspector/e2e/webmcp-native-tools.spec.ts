/**
 * A browser agent driving MCPJam, in a real browser.
 *
 * Everything else about native publication is tested against a fake
 * (`client/src/lib/webmcp/__tests__/native-tool-publisher.test.ts`). This spec
 * is the one that uses the actual platform: a Chromium with WebMCP enabled,
 * the built app, and the CDP `WebMCP` domain standing in for the external
 * agent — the same surface Chrome's own tool inspector and any browser agent
 * see. It answers the questions a fake cannot: are MCPJam's tools really
 * advertised to an agent nobody wired up, does invoking one really move the
 * UI, and are the conversation-only tools really absent?
 *
 * Requires the pinned Chromium (WebMCP is Chromium 151+ behind
 * `--enable-features=WebMCP`). Locally, a browser without it skips; in CI it
 * fails, because a silent skip there would mean the only real-browser test of
 * this feature quietly stopped running.
 */
import { expect, test, type CDPSession, type Page } from "@playwright/test";

test.use({ launchOptions: { args: ["--enable-features=WebMCP"] } });

/**
 * Local build only, like the NUX spec. A hosted deployment puts a WorkOS
 * sign-in in front of the inspector chrome this drives, so a run against
 * `PLAYWRIGHT_BASE_URL` would report a product failure for a screen that is
 * correctly behind auth. Publication itself is not mode-specific — the App
 * root mounts the publisher in both — so the local build covers it.
 */
test.skip(
  !!process.env.PLAYWRIGHT_BASE_URL,
  "drives the inspector chrome, which a deployed target puts behind auth",
);

interface ToolPayload {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  annotations?: {
    readOnly?: boolean;
    untrustedContent?: boolean;
    consequential?: boolean;
  };
  frameId: string;
}

interface RespondedPayload {
  invocationId: string;
  status: "Completed" | "Canceled" | "Error";
  output?: { content?: Array<{ type: string; text?: string }> };
  exception?: { description?: string };
}

/** The agent's view of the page: what it can see, and how it calls it. */
class BrowserAgent {
  private readonly added: ToolPayload[] = [];
  private readonly removed: Array<{ name: string }> = [];
  private readonly responded: RespondedPayload[] = [];
  private frameId = "";

  private constructor(
    private readonly page: Page,
    private readonly cdp: CDPSession,
  ) {}

  static async attach(page: Page): Promise<BrowserAgent> {
    const cdp = await page.context().newCDPSession(page);
    const agent = new BrowserAgent(page, cdp);
    cdp.on("WebMCP.toolsAdded", (event) =>
      agent.added.push(...((event as { tools: ToolPayload[] }).tools ?? [])),
    );
    cdp.on("WebMCP.toolsRemoved", (event) =>
      agent.removed.push(
        ...((event as { tools: Array<{ name: string }> }).tools ?? []),
      ),
    );
    cdp.on("WebMCP.toolResponded", (event) =>
      agent.responded.push(event as RespondedPayload),
    );
    await cdp.send("WebMCP.enable" as never);
    return agent;
  }

  async resolveFrame(): Promise<void> {
    const { frameTree } = (await this.cdp.send(
      "Page.getFrameTree" as never,
    )) as {
      frameTree: { frame: { id: string } };
    };
    this.frameId = frameTree.frame.id;
  }

  /** Tools currently advertised to this agent. */
  discover(): string[] {
    const gone = new Set(this.removed.map((tool) => tool.name));
    return [...new Set(this.added.map((tool) => tool.name))]
      .filter((name) => !gone.has(name))
      .sort();
  }

  tool(name: string): ToolPayload {
    const found = this.added.find((entry) => entry.name === name);
    if (!found) throw new Error(`the page never published "${name}"`);
    return found;
  }

  async waitForTool(name: string, timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.discover().includes(name)) return;
      await this.page.waitForTimeout(100);
    }
    throw new Error(`"${name}" was never published (waited ${timeoutMs}ms)`);
  }

  async invoke(
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<RespondedPayload> {
    const { invocationId } = (await this.cdp.send(
      "WebMCP.invokeTool" as never,
      { frameId: this.frameId, toolName, input } as never,
    )) as { invocationId: string };
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const done = this.responded.find(
        (entry) => entry.invocationId === invocationId,
      );
      if (done) return done;
      await this.page.waitForTimeout(50);
    }
    throw new Error(`"${toolName}" never answered`);
  }

  /** The browser's own rejection for a name it does not hold. */
  async invokeExpectingRejection(toolName: string): Promise<string> {
    try {
      await this.cdp.send(
        "WebMCP.invokeTool" as never,
        { frameId: this.frameId, toolName, input: {} } as never,
      );
      return "";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }
}

/** The JSON payload MCPJam's tools answer with. */
function readResult(response: RespondedPayload): unknown {
  expect(
    response.status,
    `invocation failed: ${response.exception?.description ?? ""}`,
  ).toBe("Completed");
  const text = response.output?.content?.[0]?.text ?? "";
  return JSON.parse(text);
}

test("a browser agent discovers MCPJam's tools, navigates, and reads the screen it landed on", async ({
  page,
}) => {
  // A returning user: no first-run redirect racing the agent's navigation.
  await page.addInitScript(() => {
    window.localStorage.setItem(
      "mcp-onboarding-state",
      JSON.stringify({ status: "completed", completedAt: 1 }),
    );
  });

  const agent = await BrowserAgent.attach(page);
  await page.goto("/");
  await expect(page.getByTestId("app-shell")).toBeVisible({ timeout: 30_000 });
  await agent.resolveFrame();

  const webMcpAvailable = await page.evaluate(
    "!!(document.modelContext ?? navigator.modelContext)",
  );
  test.skip(
    !webMcpAvailable && !process.env.CI,
    "WebMCP needs Chromium 151+ with --enable-features=WebMCP; install the pinned Playwright browser",
  );
  expect(
    webMcpAvailable,
    "the pinned Chromium must expose the WebMCP page API",
  ).toBe(true);

  // 1. DISCOVERY. Nobody opened Ask MCPJam; the tools are simply there.
  await agent.waitForTool("ui_navigate");
  const published = agent.discover();
  expect(published).toEqual(
    expect.arrayContaining([
      "ui_navigate",
      "ui_select_server",
      "ui_snapshot_app",
      "ui_open_playground",
      "ui_execute_tool",
      "ui_add_server",
    ]),
  );

  // …and the conversation-only tools are not, in the only way that counts:
  // the browser does not have them to invoke.
  expect(published).not.toContain("ui_ask_user");
  expect(published.filter((name) => name.startsWith("ui_eval_"))).toEqual([]);
  expect(await agent.invokeExpectingRejection("ui_ask_user")).toContain(
    "Tool not found",
  );

  // 2. WHAT MCPJAM CLAIMS. Chromium 151 reports `readOnlyHint` and
  // `untrustedContentHint` under bare names and does not carry
  // `consequentialHint` through at all — so a tool whose result quotes an MCP
  // server says so, here, in the browser's own vocabulary.
  expect(agent.tool("ui_execute_tool").annotations).toMatchObject({
    readOnly: false,
    untrustedContent: true,
  });
  expect(agent.tool("ui_navigate").annotations).toMatchObject({
    readOnly: false,
    untrustedContent: false,
  });

  // 3. NAVIGATION, invoked by the agent — and visible on screen.
  const navigated = readResult(
    await agent.invoke("ui_navigate", { target: "oauth-flow" }),
  );
  expect(navigated).toMatchObject({
    ok: true,
    data: { activeTab: "oauth-flow" },
  });
  await page.waitForURL("**/oauth-flow", { timeout: 15_000 });
  // The sidebar marks the screen the user is looking at. This is the "the
  // user sees the page change" half of every navigation tool's description.
  await expect(
    page.getByRole("button", { name: "OAuth Debugger" }),
  ).toHaveAttribute("data-active", "true", { timeout: 15_000 });

  // 4. THE DESTINATION'S TOOLS. Discovery survives the navigation — this is a
  // single-page app, so the registrations the agent holds must still be the
  // live ones rather than stale entries from the previous screen.
  await agent.waitForTool("ui_snapshot_app");
  expect(agent.discover()).toEqual(expect.arrayContaining(["ui_snapshot_app"]));

  // 5. INVOKE ONE, AND CHECK IT AGAINST WHAT IS ON SCREEN. `ui_snapshot_app`
  // reports what the user currently sees, so its answer and the browser's own
  // URL have to agree — if the agent were talking to a stale registration,
  // this is where it would show.
  const snapshot = readResult(await agent.invoke("ui_snapshot_app", {})) as {
    ok: boolean;
    data: { path: string; activeTab: string };
  };
  expect(snapshot.ok).toBe(true);
  expect(snapshot.data.activeTab).toBe("oauth-flow");
  expect(new URL(page.url()).pathname).toBe(snapshot.data.path);

  // 6. A MALFORMED CALL gets a usable answer rather than a hang or a crash.
  const rejected = await agent.invoke("ui_navigate", {
    target: "not-a-real-screen",
  });
  expect(rejected.status).toBe("Completed");
  expect(rejected.output?.content?.[0]?.text).toContain(
    'Unknown navigation target "not-a-real-screen"',
  );
});
