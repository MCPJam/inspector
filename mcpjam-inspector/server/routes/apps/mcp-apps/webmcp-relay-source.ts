import { WEBMCP_WIRE_SOURCE } from "./webmcp-wire-source.js";

/** Proxy-local relay. Each factory owns one view's requests and registrations. */
export const WEBMCP_RELAY_SOURCE = `
${WEBMCP_WIRE_SOURCE}
function createWebmcpRelay(options) {
  let enabled = false;
  let epoch = 0;
  let sequence = 0;
  let changedTimer = null;
  let names = new Set();
  const requests = new Map();
  const notify = () => options.post({jsonrpc: "2.0", method: webmcpWire.contract.changed});
  const rpcError = (id, code, message) => options.post({jsonrpc: "2.0", id, error: {code, message}});
  const finish = (key, response) => {
    const pending = requests.get(key);
    if (!pending) return;
    requests.delete(key);
    if (pending.timer) clearTimeout(pending.timer);
    options.post({jsonrpc: "2.0", id: pending.id, ...response});
  };
  return {
    configure(value) { enabled = value === true; },
    reset() {
      const announce = names.size > 0 || requests.size > 0;
      epoch++;
      if (changedTimer !== null) clearTimeout(changedTimer);
      changedTimer = null;
      names.clear();
      for (const key of requests.keys()) finish(key, {error: {code: -32603, message: "App view closed or remounted"}});
      if (announce) notify();
    },
    host(data) {
      if (!webmcpWire.object(data)) return false;
      if (data.method === "notifications/cancelled") {
        for (const [key, pending] of requests) {
          if (pending.id !== (data.params || {}).requestId) continue;
          options.send({type: "mcpjam:webmcp/cancel", requestId: key});
          finish(key, {error: {code: -32800, message: "App tool call cancelled"}});
          return true;
        }
        return false;
      }
      if (data.method !== webmcpWire.contract.list && data.method !== webmcpWire.contract.call) return false;
      if (typeof data.id !== "number" && typeof data.id !== "string") return true;
      if (!enabled) { rpcError(data.id, -32601, "WebMCP app tools are disabled"); return true; }
      if (!options.live()) { rpcError(data.id, -32603, "App view is unavailable"); return true; }
      const list = data.method === webmcpWire.contract.list;
      const params = data.params || {};
      if (!list && !names.has(params.name)) { rpcError(data.id, -32602, "Unknown WebMCP tool"); return true; }
      const key = epoch + ":" + (++sequence);
      const pending = {id: data.id, list, timer: null};
      if (list) pending.timer = setTimeout(() => finish(key, {error: {code: -32603, message: "WebMCP tool listing timed out"}}), 10000);
      requests.set(key, pending);
      options.send(list ? {type: "mcpjam:webmcp/list", requestId: key}
        : {type: "mcpjam:webmcp/call", requestId: key, name: params.name, input: params.arguments || {}});
      return true;
    },
    view(data) {
      if (!webmcpWire.object(data) || typeof data.type !== "string" || !data.type.startsWith("mcpjam:webmcp/")) return false;
      if (!enabled) return true;
      if (data.type === "mcpjam:webmcp/tools-changed") {
        if (changedTimer === null) changedTimer = setTimeout(() => { changedTimer = null; notify(); }, 250);
        return true;
      }
      const pending = requests.get(data.requestId);
      if (!pending) return true;
      if (pending.list && data.type === "mcpjam:webmcp/list-result") {
        if (data.replaced || !Array.isArray(data.tools)) {
          finish(data.requestId, {error: {code: -32603, message: "WebMCP registry is unavailable or replaced"}});
          return true;
        }
        const tools = data.tools.slice(0, webmcpWire.contract.maxTools).map(webmcpWire.tool).filter(Boolean);
        names = new Set(tools.map(tool => tool.name));
        finish(data.requestId, {result: {tools}});
      } else if (!pending.list && data.type === "mcpjam:webmcp/call-result") {
        try {
          if (typeof data.ok !== "boolean") throw new Error("Malformed WebMCP tool result");
          if (webmcpWire.bytes(data) > webmcpWire.contract.maxResultBytes) throw new Error("Tool result exceeds the 256 KiB limit");
          finish(data.requestId, {result: data.ok ? webmcpWire.success(webmcpWire.snapshot(data.value)) : webmcpWire.failure(data.error)});
        } catch (error) { finish(data.requestId, {result: webmcpWire.failure(error)}); }
      }
      return true;
    }
  };
}
`;
