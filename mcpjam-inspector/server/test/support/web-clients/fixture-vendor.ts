/**
 * A fixture "vendor": a small chat website with stable selectors whose own
 * backend is an MCP client, the way claude.ai's and chatgpt.com's are.
 *
 * The page signs in with a cookie, keeps connectors (a name and a URL), opens
 * chats and sends a prompt. The backend then dials each enabled connector,
 * lists its tools, asks the page to approve the call (Always allow / Allow
 * once), and calls the first tool with `_meta["claudecode/toolUseId"]`, as
 * claude.ai's client does, or with no id, as chatgpt.com's does. Each chat is
 * saved as JSON the page module reads.
 *
 * Test-only. `fixture-web.ts` is the page module that drives it.
 */
import { randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

type Chat = {
  id: string;
  prompt: string;
  /** When the backend created it, as `toISOString()` writes it. */
  createdAt: string;
  state: "running" | "awaiting_approval" | "done";
  reply: string;
  toolCalls: Array<{ toolUseId?: string; name: string; at: string }>;
  approve?: (always: boolean) => void;
};

export type FixtureVendor = {
  url: string;
  /** Prompts the backend received, one per send. */
  sends: string[];
  chats: Map<string, Chat>;
  connectors: Map<string, string>;
  /** Shows a human check on every page while set. */
  challenge: boolean;
  /** Calls tools with no tool use id, on the wire or in the chat, as chatgpt.com does. */
  withoutToolUseIds: boolean;
  /** Where `/redirect` sends the page, like a vendor link to another site. */
  redirectTo?: string;
  close(): Promise<void>;
};

const SESSION = "fixture_session";

async function rpc(
  url: string,
  sessionId: string | undefined,
  body: Record<string, unknown>,
): Promise<{ result?: Record<string, unknown>; sessionId?: string }> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", ...body }),
  });
  const next = response.headers.get("mcp-session-id") ?? sessionId ?? undefined;
  if (!("id" in body)) return { sessionId: next };
  const raw = await response.text();
  const json = (response.headers.get("content-type") ?? "").includes("event-stream")
    ? raw.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5)).at(-1) ?? "{}"
    : raw;
  const parsed = JSON.parse(json) as { result?: Record<string, unknown>; error?: { message: string } };
  if (parsed.error) throw new Error(parsed.error.message);
  return { result: parsed.result, sessionId: next };
}

function page(title: string, body: string, script = ""): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}<script>${script}</script></body></html>`;
}

const CHAT_SCRIPT = `
const id = location.pathname.split('/').pop();
async function tick() {
  const state = await (await fetch('/api/chats/' + id)).json();
  document.querySelector('[data-testid=reply-status]').dataset.state = state.state;
  document.querySelector('[data-testid=assistant-message]').textContent = state.reply;
  document.querySelector('[data-testid=approval]').hidden = state.state !== 'awaiting_approval';
  if (state.state !== 'done') setTimeout(tick, 100);
}
for (const button of document.querySelectorAll('[data-approve]')) {
  button.onclick = () => fetch('/api/chats/' + id + '/approve', { method: 'POST', body: button.dataset.approve });
}
tick();`;

const NEW_SCRIPT = `
document.querySelector('[data-testid=send]').onclick = async () => {
  const connectors = [...document.querySelectorAll('[data-testid=connector-toggle][aria-checked=true]')].map((t) => t.dataset.name);
  const prompt = document.querySelector('[data-testid=composer]').value;
  const chat = await (await fetch('/api/chats', { method: 'POST', body: JSON.stringify({ prompt, connectors }) })).json();
  location.href = '/chat/' + chat.id;
};
for (const toggle of document.querySelectorAll('[data-testid=connector-toggle]')) {
  toggle.onclick = () => toggle.setAttribute('aria-checked', String(toggle.getAttribute('aria-checked') !== 'true'));
}`;

const CONNECTORS_SCRIPT = `
document.querySelector('[data-testid=connector-add]').onclick = async () => {
  const name = document.querySelector('[data-testid=connector-name]').value;
  const url = document.querySelector('[data-testid=connector-url]').value;
  await fetch('/api/connectors', { method: 'POST', body: JSON.stringify({ name, url }) });
  location.reload();
};
for (const remove of document.querySelectorAll('[data-testid=connector-remove]')) {
  remove.onclick = async () => { await fetch('/api/connectors/' + encodeURIComponent(remove.dataset.name), { method: 'DELETE' }); location.reload(); };
}`;

const escape = (value: string) =>
  value.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export async function startFixtureVendor(): Promise<FixtureVendor> {
  const vendor: Omit<FixtureVendor, "url" | "close"> = {
    sends: [],
    chats: new Map(),
    connectors: new Map(),
    challenge: false,
    withoutToolUseIds: false,
  };
  // The tools a person chose Always allow for, by connector name. A
  // connector removed, or added again at another address, starts over.
  const alwaysAllowed = new Map<string, Set<string>>();

  async function runTurn(chat: Chat, enabled: string[]) {
    try {
      for (const name of enabled) {
        const url = vendor.connectors.get(name);
        if (!url) continue;
        const init = await rpc(url, undefined, {
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fixture-vendor", version: "1.0.0" } },
        });
        await rpc(url, init.sessionId, { method: "notifications/initialized" });
        const listed = await rpc(url, init.sessionId, { id: 2, method: "tools/list" });
        const tool = (listed.result?.tools as Array<{ name: string }> | undefined)?.[0];
        if (!tool) continue;
        const allowed = alwaysAllowed.get(name) ?? new Set<string>();
        if (!allowed.has(tool.name)) {
          chat.state = "awaiting_approval";
          const always = await new Promise<boolean>((resolve) => (chat.approve = resolve));
          if (always) alwaysAllowed.set(name, allowed.add(tool.name));
          chat.state = "running";
        }
        const toolUseId = vendor.withoutToolUseIds ? undefined : `toolu_fixture_${randomUUID().slice(0, 8)}`;
        chat.toolCalls.push({ ...(toolUseId ? { toolUseId } : {}), name: tool.name, at: new Date().toISOString() });
        const called = await rpc(url, init.sessionId, {
          id: 3,
          method: "tools/call",
          params: {
            name: tool.name,
            arguments: { message: chat.prompt },
            _meta: { ...(toolUseId ? { "claudecode/toolUseId": toolUseId } : {}), progressToken: 7 },
          },
        });
        const content = called.result?.content as Array<{ text?: string }> | undefined;
        chat.reply = `${tool.name} said: ${content?.[0]?.text ?? ""}`;
      }
      if (!chat.reply) chat.reply = "No tools were used.";
    } catch (error) {
      chat.reply = `The tool call failed: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      chat.state = "done";
    }
  }

  const answer = async (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", "http://fixture.local");
    const cookie = /fixture_session=([^;]+)/.exec(request.headers.cookie ?? "")?.[1];
    const email = cookie ? decodeURIComponent(cookie) : undefined;
    const html = (body: string) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(body);
    };
    const json = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (url.pathname === "/redirect") {
      // The test chooses the target, so no request decides where this goes.
      response.writeHead(302, { location: vendor.redirectTo ?? "/new" });
      response.end();
      return;
    }
    if (url.pathname === "/sign-in") {
      const as = url.searchParams.get("as") ?? "person@example.com";
      response.writeHead(302, { "set-cookie": `${SESSION}=${encodeURIComponent(as)}; Path=/`, location: "/new" });
      response.end();
      return;
    }
    if (vendor.challenge && !url.pathname.startsWith("/api/")) {
      html(page("Just a moment", "<h1>Verify you are human</h1>"));
      return;
    }
    if (!email) {
      if (url.pathname.startsWith("/api/")) return json(401, { error: "signed out" });
      html(page("Log in", '<form data-testid="login"><input type="email"><input type="password"></form>'));
      return;
    }
    const chatMatch = /^\/api\/chats\/([^/]+)(\/approve)?$/.exec(url.pathname);
    if (url.pathname === "/new") {
      const toggles = [...vendor.connectors.keys()]
        .map((name) => `<button role="menuitemcheckbox" aria-checked="false" data-testid="connector-toggle" data-name="${escape(name)}">${escape(name)}</button>`)
        .join("");
      html(page("New chat", `<span data-testid="account-email">${escape(email)}</span><div data-testid="connector-menu">${toggles}</div><textarea data-testid="composer"></textarea><button data-testid="send">Send</button>`, NEW_SCRIPT));
    } else if (url.pathname === "/connectors") {
      const rows = [...vendor.connectors.entries()]
        .map(([name, target]) => `<li data-testid="connector-row" data-name="${escape(name)}" data-url="${escape(target)}" data-status="connected">${escape(name)} ${escape(target)}<button data-testid="connector-remove" data-name="${escape(name)}">Remove</button></li>`)
        .join("");
      html(page("Connectors", `<ul>${rows}</ul><input data-testid="connector-name"><input data-testid="connector-url"><button data-testid="connector-add">Add</button>`, CONNECTORS_SCRIPT));
    } else if (url.pathname.startsWith("/chat/")) {
      const chat = vendor.chats.get(url.pathname.slice("/chat/".length));
      if (!chat) return json(404, { error: "no chat" });
      html(page("Chat", `<div data-testid="user-message">${escape(chat.prompt)}</div><div data-testid="approval" hidden><button data-approve="true" data-testid="approve-always">Always allow</button><button data-approve="false" data-testid="approve-once">Allow once</button></div><div data-testid="assistant-message"></div><div data-testid="reply-status" data-state="running"></div>`, CHAT_SCRIPT));
    } else if (url.pathname === "/api/me") {
      json(200, { email, workspace: "Fixture workspace" });
    } else if (url.pathname === "/api/connectors" && request.method === "POST") {
      const { name, url: target } = JSON.parse(await readBody(request)) as { name: string; url: string };
      if (vendor.connectors.get(name) !== target) alwaysAllowed.delete(name);
      vendor.connectors.set(name, target);
      json(200, { ok: true });
    } else if (url.pathname.startsWith("/api/connectors/") && request.method === "DELETE") {
      const name = decodeURIComponent(
        url.pathname.slice("/api/connectors/".length),
      );
      vendor.connectors.delete(name);
      alwaysAllowed.delete(name);
      json(200, { ok: true });
    } else if (url.pathname === "/api/chats" && request.method === "POST") {
      const { prompt, connectors } = JSON.parse(await readBody(request)) as { prompt: string; connectors: string[] };
      vendor.sends.push(prompt);
      const chat: Chat = {
        id: randomUUID(),
        prompt,
        createdAt: new Date().toISOString(),
        state: "running",
        reply: "",
        toolCalls: [],
      };
      vendor.chats.set(chat.id, chat);
      void runTurn(chat, connectors);
      json(200, { id: chat.id });
    } else if (url.pathname === "/api/chats" && request.method === "GET") {
      json(
        200,
        [...vendor.chats.values()]
          .reverse()
          .map((chat) => ({ id: chat.id, createdAt: chat.createdAt })),
      );
    } else if (chatMatch && chatMatch[2] && request.method === "POST") {
      vendor.chats.get(chatMatch[1]!)?.approve?.((await readBody(request)) === "true");
      json(200, { ok: true });
    } else if (chatMatch) {
      const chat = vendor.chats.get(chatMatch[1]!);
      if (!chat) return json(404, { error: "no chat" });
      json(200, {
        id: chat.id,
        state: chat.state,
        reply: chat.reply,
        messages: [
          { role: "user", text: chat.prompt },
          ...(chat.state === "done" ? [{ role: "assistant", text: chat.reply }] : []),
        ],
        toolCalls: chat.toolCalls,
      });
    } else {
      json(404, { error: "not found" });
    }
  };
  const server = createServer((request, response) => {
    // Node ignores the promise a listener returns, so a failure is settled
    // here rather than escape the test as an unhandled rejection.
    void answer(request, response).catch((error: unknown) => {
      // A client that hung up mid-request has no socket left to answer on.
      if (response.destroyed || response.headersSent) return;
      response.writeHead(error instanceof SyntaxError ? 400 : 500, {
        "content-type": "application/json",
      });
      response.end(JSON.stringify({ error: String(error) }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return Object.assign(vendor, {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  });
}
