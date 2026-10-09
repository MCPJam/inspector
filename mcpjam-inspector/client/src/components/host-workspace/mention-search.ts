import {
  parsePluginMentionItems,
  pluginMentionQuerySchema,
  type PluginMentionSelection,
} from "@/shared/plugin-mentions";
import { z } from "zod";
import { waitForPluginOperation } from "@/shared/plugin-operation";

export type PluginMentionProvider = {
  projectId: string;
  hostId: string;
  serverId: string;
  serverName?: string;
};
const openedSchema = z.strictObject({
  mention: z
    .strictObject({
      instanceToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
      toolName: z.string().min(1).max(256),
      title: z.string(),
    })
    .nullable(),
});

type MentionPost = (
  action: string,
  body: unknown,
  signal?: AbortSignal,
) => Promise<Response>;

/**
 * Does this server declare a mention search tool? Opens and immediately
 * closes one headless lease; the composer caches the answer per session so
 * typing "@" never re-probes every server.
 */
export async function probePluginMention(input: {
  provider: PluginMentionProvider;
  workspaceId: string;
  signal: AbortSignal;
  post: MentionPost;
  cleanupError: (error: unknown) => void;
}): Promise<{ toolName: string; title: string } | null> {
  const { provider, signal, post } = input;
  const scope = {
    projectId: provider.projectId,
    pluginWorkspace: { version: 1, workspaceId: input.workspaceId },
  };
  const close = async (token: string) => {
    try {
      const response = await waitForPluginOperation(
        AbortSignal.timeout(5000),
        () => post("mentions/close", { ...scope, instanceToken: token }),
      );
      if (!response.ok)
        throw new Error(`Mention cleanup rejected (${response.status})`);
    } catch (error) {
      input.cleanupError(error);
    }
  };
  signal.throwIfAborted();
  const mention = await waitForPluginOperation(signal, async () => {
    const opened = await post(
      "mentions/open",
      { ...scope, hostId: provider.hostId, serverId: provider.serverId },
      signal,
    );
    if (!opened.ok)
      throw new Error(`Mention discovery rejected (${opened.status})`);
    const mention = openedSchema.parse(await opened.json()).mention;
    // A lease returned after the caller left is still closed.
    if (mention && signal.aborted) {
      void close(mention.instanceToken);
      signal.throwIfAborted();
    }
    return mention;
  });
  if (!mention) return null;
  await close(mention.instanceToken);
  return { toolName: mention.toolName, title: mention.title };
}

/** One headless lifetime per search. No automatic retries or retained credentials. */
export async function searchPluginMentions(input: {
  provider: PluginMentionProvider;
  query: string;
  signal: AbortSignal;
  requireLive: () => void;
  post: (
    action: string,
    body: unknown,
    signal?: AbortSignal,
  ) => Promise<Response>;
  approve: (
    challenge: { name: string; params: Record<string, unknown> },
    signal: AbortSignal,
  ) => Promise<boolean>;
  workspaceId: string;
  cleanupError: (error: unknown) => void;
}): Promise<PluginMentionSelection[]> {
  const { provider, signal, requireLive, post } = input;
  const params = pluginMentionQuerySchema.parse({ query: input.query });
  const scope = {
    projectId: provider.projectId,
    pluginWorkspace: { version: 1, workspaceId: input.workspaceId },
  };
  const close = async (token: string) => {
    try {
      const response = await waitForPluginOperation(
        AbortSignal.timeout(5000),
        () => post("mentions/close", { ...scope, instanceToken: token }),
      );
      if (!response.ok)
        throw new Error(`Mention cleanup rejected (${response.status})`);
    } catch (error) {
      input.cleanupError(error);
    }
  };
  let token: string | undefined;
  try {
    requireLive();
    signal.throwIfAborted();
    const mention = await waitForPluginOperation(signal, async () => {
      const opened = await post(
        "mentions/open",
        { ...scope, hostId: provider.hostId, serverId: provider.serverId },
        signal,
      );
      if (!opened.ok)
        throw new Error(`Mention discovery rejected (${opened.status})`);
      const mention = openedSchema.parse(await opened.json()).mention;
      if (mention && signal.aborted) {
        void close(mention.instanceToken);
        signal.throwIfAborted();
      }
      return mention;
    });
    if (!mention) return [];
    token = mention.instanceToken;
    requireLive();
    signal.throwIfAborted();
    const request = {
      ...scope,
      instanceToken: token,
      invocationId: crypto.randomUUID(),
      params,
    };
    let response = await waitForPluginOperation(signal, () =>
      post("mentions/search", request, signal),
    );
    let reply = await waitForPluginOperation(signal, () => response.json());
    requireLive();
    signal.throwIfAborted();
    if (response.status === 409 && reply.status === "approval_required") {
      if (
        reply.approval?.invocationId !== request.invocationId ||
        reply.approval?.name !== mention.toolName ||
        JSON.stringify(reply.approval?.params) !==
          JSON.stringify({ name: mention.toolName, arguments: params })
      )
        throw new Error("Invalid mention approval");
      if (
        !(await waitForPluginOperation(signal, () =>
          input.approve(reply.approval, signal),
        ))
      )
        throw new Error("Mention search declined");
      requireLive();
      signal.throwIfAborted();
      response = await waitForPluginOperation(signal, () =>
        post(
          "mentions/search",
          { ...request, approval: { id: reply.approval.id, approved: true } },
          signal,
        ),
      );
      reply = await waitForPluginOperation(signal, () => response.json());
    }
    requireLive();
    signal.throwIfAborted();
    if (!response.ok || reply.status !== "completed")
      throw new Error(`Mention search rejected (${response.status})`);
    return parsePluginMentionItems(reply.result).map((item) => ({
      serverId: provider.serverId,
      toolName: mention.toolName,
      item,
    }));
  } finally {
    if (token) {
      const closing = close(token);
      if (signal.aborted) void closing;
      else await closing;
    }
  }
}
