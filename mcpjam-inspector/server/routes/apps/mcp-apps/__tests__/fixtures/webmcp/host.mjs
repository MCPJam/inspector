import {
  AppBridge,
  PostMessageTransport,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import {
  appToolSourceFor,
  discoverViewAppTools,
  callViewWebmcpTool,
  listViewWebmcpTools,
} from "spike-runtime";

const entries = new Map();
const traffic = [];
window.addEventListener("message", (event) => {
  if (event.data?.jsonrpc) traffic.push(event.data);
});

const spike = {
  traffic,
  list(id) {
    return listViewWebmcpTools(entries.get(id).bridge);
  },
  remount(id) {
    const entry = entries.get(id);
    const ready = new Promise((resolve) => {
      entry.bridge.oninitialized = resolve;
    });
    entry.frame.contentWindow.postMessage(entry.resource, "*");
    return ready;
  },
  async mount({
    id,
    source = "direct",
    mode = "write",
    enabled = true,
    baseline = false,
    permissive = false,
  }) {
    const frame = document.createElement("iframe");
    frame.dataset.id = id;
    const bridge = new AppBridge(
      null,
      { name: "MCPJam S0", version: "1.0.0" },
      {},
    );
    let initialized;
    const ready = new Promise((resolve) => {
      initialized = resolve;
    });
    bridge.oninitialized = () => initialized();
    const html = await fetch(`/view?source=${source}&id=${id}`).then(
      (response) => response.text(),
    );
    const proxyReady = new Promise((resolve) => {
      const receive = (event) => {
        if (
          event.source !== frame.contentWindow ||
          event.data?.method !== "ui/notifications/sandbox-proxy-ready"
        )
          return;
        window.removeEventListener("message", receive);
        resolve();
      };
      window.addEventListener("message", receive);
    });
    frame.src =
      location.origin.replace("127.0.0.1", "localhost") +
      `/proxy?baseline=${baseline}`;
    document.body.appendChild(frame);
    await proxyReady;
    await bridge.connect(
      new PostMessageTransport(frame.contentWindow, frame.contentWindow),
    );
    const resource = {
      jsonrpc: "2.0",
      method: "ui/notifications/sandbox-resource-ready",
      params: {
        html,
        mountMode: mode,
        ...(typeof enabled === "boolean" ? { webmcpTools: enabled } : {}),
        permissive,
        cspDirectives: { "script-src": ["'unsafe-inline'"] },
      },
    };
    frame.contentWindow.postMessage(resource, "*");
    await ready;
    const candidate = appToolSourceFor(bridge.getAppCapabilities(), {
      webmcpTools: enabled === true,
    });
    const discovery = candidate
      ? await discoverViewAppTools(
          bridge,
          candidate,
          enabled,
          async () => (await bridge.listTools({})).tools,
        )
      : { source: null, tools: [] };
    entries.set(id, { bridge, frame, resource, source: discovery.source });
    return discovery;
  },
  async call(id, input = {}, cancelAfter = 0) {
    const entry = entries.get(id);
    const controller = new AbortController();
    const timer = cancelAfter
      ? setTimeout(() => controller.abort(), cancelAfter)
      : null;
    try {
      return entry.source === "mcp-apps"
        ? await entry.bridge.callTool({ name: "make_move", arguments: input })
        : await callViewWebmcpTool(entry.bridge, "make_move", input, {
            signal: controller.signal,
          });
    } finally {
      if (timer) clearTimeout(timer);
    }
  },
  async close(id) {
    const entry = entries.get(id);
    await entry.bridge.close();
    entry.frame.remove();
    entries.delete(id);
  },
};
Reflect.set(window, "spike", spike);
