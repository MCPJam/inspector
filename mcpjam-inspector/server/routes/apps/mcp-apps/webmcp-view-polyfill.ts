import { WEBMCP_WIRE_SOURCE } from "./webmcp-wire-source.js";

/**
 * Adapted from the ext-apps ModelContext polyfill (Apache-2.0).
 * https://github.com/modelcontextprotocol/ext-apps/blob/efcc19c377770f64d4844485bb2be73a6c4b813c/src/model-context-host.ts
 * Changes: private messages, native shadowing, bounded results and cancellation.
 */
export const WEBMCP_VIEW_POLYFILL_JS = `(function (doc) {
${WEBMCP_WIRE_SOURCE}
  const marker = Symbol.for("mcpjam.webmcp.polyfill");
  const registry = new Map();
  const calls = new Map();
  let changeQueued = false;
  let context;
  const isReplaced = () => {
    try { return doc.modelContext !== context; }
    catch (error) { return true; }
  };
  const post = message => window.parent.postMessage(message, "*");
  const changed = () => {
    if (changeQueued) return;
    changeQueued = true;
    Promise.resolve().then(() => {
      changeQueued = false;
      context.dispatchEvent(new Event("toolchange"));
      post({type: "mcpjam:webmcp/tools-changed"});
    });
  };
  class ModelContext extends EventTarget {
    constructor() { super(); this.handler = null; }
    get ontoolchange() { return this.handler; }
    set ontoolchange(handler) {
      if (this.handler) this.removeEventListener("toolchange", this.handler);
      this.handler = typeof handler === "function" ? handler : null;
      if (this.handler) this.addEventListener("toolchange", this.handler);
    }
    async registerTool(raw, options = {}) {
      const signal = options.signal;
      if (signal && signal.aborted) throw signal.reason;
      const descriptor = webmcpWire.tool(raw);
      if (!descriptor) throw new TypeError("Invalid WebMCP tool descriptor");
      const execute = raw.execute;
      if (typeof execute !== "function") throw new TypeError("Tool execute must be a function");
      if (registry.has(descriptor.name)) throw new DOMException("Duplicate tool name", "InvalidStateError");
      if (registry.size >= webmcpWire.contract.maxTools) throw new Error("Too many WebMCP tools");
      const entry = {descriptor, execute};
      registry.set(descriptor.name, entry);
      if (signal) signal.addEventListener("abort", () => {
        if (registry.get(descriptor.name) !== entry) return;
        registry.delete(descriptor.name);
        changed();
      }, {once: true});
      changed();
    }
    async getTools() {
      return Array.from(registry.values(), entry => ({
        ...webmcpWire.snapshot(entry.descriptor), window: doc.defaultView,
        origin: doc.location.origin
      }));
    }
    async invoke(name, input, signal) {
      const entry = registry.get(name);
      if (!entry) throw new Error("Unknown WebMCP tool: " + name);
      if (signal.aborted) throw signal.reason;
      let abort;
      const stopped = new Promise((resolve, reject) => {
        abort = () => reject(signal.reason || new DOMException("Cancelled", "AbortError"));
        signal.addEventListener("abort", abort, {once: true});
      });
      try {
        const work = Promise.resolve().then(() => entry.execute(webmcpWire.snapshot(input), {signal}));
        return await Promise.race([work, stopped]);
      } finally { signal.removeEventListener("abort", abort); }
    }
    async executeTool(tool, input = {}, options = {}) {
      const signal = options.signal || new AbortController().signal;
      const value = webmcpWire.snapshot(await this.invoke(tool.name, input, signal));
      webmcpWire.success(value);
      return JSON.stringify(value);
    }
  }
  context = new ModelContext();
  Object.defineProperty(context, marker, {value: true});
  Object.defineProperty(doc, "modelContext", {value: context, configurable: true});
  window.addEventListener("message", async event => {
    if (event.source !== window.parent || !webmcpWire.object(event.data)) return;
    const {type, requestId, name, input} = event.data;
    if (type === "mcpjam:webmcp/cancel") {
      const controller = calls.get(requestId);
      if (controller) controller.abort(new DOMException("Cancelled", "AbortError"));
      return;
    }
    if (typeof requestId !== "string") return;
    if (type === "mcpjam:webmcp/list") {
      post({type: "mcpjam:webmcp/list-result", requestId,
        replaced: isReplaced(),
        tools: Array.from(registry.values(), entry => entry.descriptor)});
    } else if (type === "mcpjam:webmcp/call") {
      if (calls.has(requestId)) return;
      const controller = new AbortController();
      calls.set(requestId, controller);
      try {
        if (isReplaced()) throw new Error("The view replaced the host WebMCP polyfill");
        const value = webmcpWire.snapshot(await context.invoke(name, input || {}, controller.signal));
        webmcpWire.success(value);
        const reply = {type: "mcpjam:webmcp/call-result", requestId, ok: true, value};
        if (webmcpWire.bytes(reply) > webmcpWire.contract.maxResultBytes) throw new Error("Tool result exceeds the 256 KiB limit");
        post(reply);
      } catch (error) {
        post({type: "mcpjam:webmcp/call-result", requestId, ok: false, error: webmcpWire.message(error)});
      } finally { calls.delete(requestId); }
    }
  });
})(document);`;
