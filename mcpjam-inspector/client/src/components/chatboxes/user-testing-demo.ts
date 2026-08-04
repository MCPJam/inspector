import type { ChatboxListItem, ChatboxSettings } from "@/hooks/useChatboxes";
import type { SharedChatThread } from "@/hooks/useSharedChatThreads";

/** Fixture rows so Overview / detail / design can be QAd without live chatboxes. */
export const USER_TESTING_DEMO_ROWS: ChatboxListItem[] = [
  {
    chatboxId: "demo-cb-1",
    projectId: "demo",
    name: "Public beta · payments API",
    hostStyle: "cursor",
    mode: "anyone_with_link",
    allowGuestAccess: true,
    serverCount: 1,
    serverNames: ["acme-payments"],
    namedHostId: "demo-host-1",
    namedHostName: "Cursor",
    createdAt: Date.now() - 86_400_000 * 3,
    updatedAt: Date.now() - 3_600_000,
  },
  {
    chatboxId: "demo-cb-2",
    projectId: "demo",
    name: "Design partners · Q3",
    hostStyle: "vscode",
    mode: "invited_only",
    allowGuestAccess: false,
    serverCount: 1,
    serverNames: ["docs-mcp"],
    namedHostId: "demo-host-2",
    namedHostName: "VS Code",
    createdAt: Date.now() - 86_400_000 * 10,
    updatedAt: Date.now() - 86_400_000,
  },
  {
    chatboxId: "demo-cb-3",
    projectId: "demo",
    name: "Docs MCP · ChatGPT rollout",
    hostStyle: "chatgpt",
    mode: "project_members",
    allowGuestAccess: false,
    serverCount: 1,
    serverNames: ["docs-mcp"],
    namedHostId: "demo-host-3",
    namedHostName: "ChatGPT",
    createdAt: Date.now() - 86_400_000 * 5,
    updatedAt: Date.now() - 12 * 3_600_000,
  },
];

export const USER_TESTING_DEMO_TESTER_COUNTS: Record<string, number> = {
  "demo-cb-1": 24,
  "demo-cb-2": 9,
  "demo-cb-3": 4,
};

export function isUserTestingDemoHostId(
  hostId: string | null | undefined,
): boolean {
  return Boolean(hostId?.startsWith("demo-host-"));
}

export function getUserTestingDemoRow(
  hostId: string,
): ChatboxListItem | undefined {
  return USER_TESTING_DEMO_ROWS.find((r) => r.namedHostId === hostId);
}

export function buildUserTestingDemoChatbox(
  hostId: string,
): ChatboxSettings | null {
  const row = getUserTestingDemoRow(hostId);
  if (!row) return null;
  return {
    chatboxId: row.chatboxId,
    projectId: row.projectId,
    name: row.name,
    description: row.description,
    hostStyle: row.hostStyle,
    systemPrompt: "",
    modelId: "anthropic/claude-sonnet-4.5",
    temperature: 0.7,
    requireToolApproval: false,
    allowGuestAccess: row.allowGuestAccess,
    mode: row.mode,
    servers: row.serverNames.map((serverName, i) => ({
      serverId: `demo-srv-${i + 1}`,
      serverName,
      useOAuth: false,
      serverUrl: null,
      clientId: null,
      oauthScopes: null,
      optional: false,
    })),
    namedHostId: row.namedHostId,
    namedHostName: row.namedHostName,
    members: [],
    link: {
      token: "demo-share-token",
      path: `/t/${row.namedHostId}`,
      url: `https://mcpjam.link/t/${row.namedHostId.replace("demo-host-", "acme-")}`,
      rotatedAt: Date.now(),
      updatedAt: Date.now(),
    },
  };
}

export const USER_TESTING_DEMO_THREADS: SharedChatThread[] = [
  {
    _id: "demo-thread-1",
    sourceType: "chatbox",
    chatSessionId: "demo-session-1",
    startedAt: Date.now() - 13 * 3_600_000,
    lastActivityAt: Date.now() - 13 * 3_600_000,
    messageCount: 4,
    toolCallCount: 2,
    synthetic: false,
    authType: "guest",
    modelId: "anthropic/claude-sonnet-4.5",
    firstMessagePreview: "What tools can I use?",
    visitorDisplayName: "Vignesh Gopalan",
  },
  {
    _id: "demo-thread-2",
    sourceType: "chatbox",
    chatSessionId: "demo-session-2",
    startedAt: Date.now() - 86_400_000,
    lastActivityAt: Date.now() - 86_400_000,
    messageCount: 6,
    toolCallCount: 3,
    synthetic: false,
    authType: "signedIn",
    modelId: "anthropic/claude-sonnet-4.5",
    firstMessagePreview: "Can you walk me through a refund?",
    visitorDisplayName: "Alex Rivera",
  },
  {
    _id: "demo-thread-3",
    sourceType: "chatbox",
    chatSessionId: "demo-session-3",
    startedAt: Date.now() - 2 * 86_400_000,
    lastActivityAt: Date.now() - 2 * 86_400_000,
    messageCount: 2,
    toolCallCount: 0,
    synthetic: false,
    authType: "guest",
    modelId: "openai/gpt-4.1",
    firstMessagePreview: "What can this server do?",
    visitorDisplayName: "Sam Chen",
  },
];

export const USER_TESTING_DEMO_SERVERS = [
  { _id: "demo-srv-1", name: "acme-payments", toolCount: 14 },
  { _id: "demo-srv-2", name: "docs-mcp", toolCount: 6 },
] as const;
