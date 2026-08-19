import type { ProductUpdateDefinition } from "./productUpdateEntry";

// Product-owned Home content. This ships with Inspector; Convex stores only
// per-user state such as dismissals and the first-seen timestamp.
export const PRODUCT_UPDATES: readonly ProductUpdateDefinition[] = [
  {
    slug: "xaa-debugger-ga",
    title: "XAA Debugger is GA",
    body: "Configure and debug Cross-App Access flows with MCPJam as the test identity provider and client/agent",
    tag: "NEW",
    href: "https://docs.mcpjam.com/inspector/xaa-debugger",
    previewVideoUrl:
      "https://outstanding-fennec-304.convex.cloud/api/storage/b3a2592b-ab5f-42df-ad2c-db4fa2f39172",
    hideControls: true,
    publishAt: 1784179142000,
  },
  {
    slug: "xaa-cli-debugger",
    title: "Debug XAA from your terminal",
    body: "`mcpjam xaa run` drives the whole Cross-App Access flow against your MCP server: discovery, mint an ID-JAG, redeem it at your auth server, then call the server with the access token. MCPJam plays the enterprise IdP, so you can test ID-JAG support without wiring one up — OIDC or SAML assertions, pre-registered, DCR, or CIMD clients.",
    tag: "NEW",
    href: "https://docs.mcpjam.com/cli/xaa",
    previewVideoUrl:
      "https://outstanding-fennec-304.convex.cloud/api/storage/d14ea926-0fd8-49ca-9507-ea9b5ebb4fee",
    publishAt: 1784157265353,
  },
  {
    slug: "slackbot-and-new-hosts",
    title: "Slackbot + 8 new hosts",
    body: "Slackbot just became an MCP host — and it lands alongside VS Code, Mistral, AgentCore, Goose, n8n, Cline, Perplexity, and Notion. That's 15 host templates you can run side-by-side to see what your users actually experience, dig into traces, and turn the differences into cross-host eval cases.",
    tag: "NEW",
    previewVideoUrl:
      "https://outstanding-fennec-304.convex.cloud/api/storage/ab940203-5472-4a77-92e1-64aeca8e6fb3",
    publishAt: 1783357200000,
  },
  {
    slug: "app-tools",
    title: "App Tools support",
    body: "Inspector now supports App Tools (SEP-1865) — your agent calls directly into the live UI instead of the host tearing down the iframe every turn. Lower latency, stateful views, multi-turn UI conversations.",
    tag: "NEW",
    previewVideoUrl:
      "https://outstanding-fennec-304.convex.cloud/api/storage/7d929dc3-3dcf-438b-8c58-88b209f7b50b",
    publishAt: 1779796800000,
  },
  {
    slug: "stateless-mcp-2026-07-28-rc",
    title: "Test stateless MCP servers",
    body: "Inspector now supports the 2026-07-28 stateless RC over Streamable HTTP alongside the current spec. Pin per-server or per-client and flip between versions — no more sticky sessions or initialize handshakes to scale around.",
    tag: "NEW",
    href: "https://lnkd.in/gGMpFb7H",
    videoUrl: "https://www.youtube.com/watch?v=gaZeiEGC8oU",
    previewVideoUrl:
      "https://outstanding-fennec-304.convex.cloud/api/storage/76f4a81d-1594-4227-9b4b-ca3a2a22c518",
    publishAt: 1780315200000,
  },
  {
    slug: "multi-client-testing",
    title: "Multi-client testing",
    body: "Run the same prompt across ChatGPT, Claude, Cursor, and other client configs side-by-side in the Playground. Isolate client/runtime differences from agent differences before shipping your server.",
    tag: "NEW",
    previewVideoUrl:
      "https://outstanding-fennec-304.convex.cloud/api/storage/c392d4b0-31b8-44d4-9f43-ff03332140dd",
    publishAt: 1779800400000,
  },
  {
    slug: "app-tools-support",
    title: "App Tools support",
    body: "(archived - replaced by app-tools)",
    archived: true,
    publishAt: 1779796800000,
  },
  {
    slug: "progressive-tool-discovery",
    title: "Progressive tool discovery",
    body: "Test progressive tool disclosure in Inspector. Your agent only sees `search_mcp_tools` and `load_mcp_tools` upfront, hydrating full schemas on demand. Cuts context bloat when you wire up 5+ servers.",
    tag: "NEW",
    previewVideoUrl:
      "https://outstanding-fennec-304.convex.cloud/api/storage/b57594c1-6632-4633-a32c-19e16f3e8e19",
    publishAt: 1780228800000,
  },
  {
    slug: "stateless-mcp-servers",
    title: "Test stateless MCP servers",
    body: "(archived - replaced by stateless-mcp-2026-07-28-rc)",
    archived: true,
    publishAt: 1780315200000,
  },
  {
    slug: "mcpjam-evals-ga",
    title: "MCPJam Evals is GA",
    body: "Ship MCP servers with confidence — durable test suites with cross-client runs, N-iteration pass rates, structural diffs against tool calls, LLM-as-a-judge assertions, and one-click CI/CD quality gates.",
    tag: "NEW",
    href: "https://docs.mcpjam.com/inspector/evals",
    videoUrl: "https://www.youtube.com/watch?v=WZPN9n87msg",
    previewVideoUrl:
      "https://outstanding-fennec-304.convex.cloud/api/storage/0ea4e98b-3ec4-40bc-9090-1595438270c7",
    publishAt: 1780574400000,
  },
];
