import { afterEach, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { destroySuspendedBridge } from "../destroy-suspended-bridge";

const servers: WebSocketServer[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          for (const socket of server.clients) socket.terminate();
          server.close(() => resolve());
        }),
    ),
  );
});

async function startBridge(token: string) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  servers.push(server);
  let destroyed = false;
  server.on("connection", (socket, request) => {
    const url = new URL(request.url!, "http://127.0.0.1");
    if (url.searchParams.get("agent_bridge_token") !== token) {
      socket.close(1008);
      return;
    }
    socket.send(JSON.stringify({ type: "bridge-hello" }));
    socket.on("message", (message) => {
      if (JSON.parse(message.toString()).type === "destroy") {
        destroyed = true;
        socket.close(1000, "destroy");
      }
    });
  });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No bound port");
  return {
    state: { data: { bridge: { port: address.port, token } } },
    endpointFor: async () => ({ url: `ws://127.0.0.1:${address.port}` }),
    destroyed: () => destroyed,
  };
}

it("destroys only the bridge named by the detached continuation", async () => {
  const original = await startBridge("original");
  const other = await startBridge("other");
  await destroySuspendedBridge(original.state, original.endpointFor);
  expect(original.destroyed()).toBe(true);
  expect(other.destroyed()).toBe(false);
});

it("reports a refused cleanup without sending destroy", async () => {
  const original = await startBridge("original");
  await expect(
    destroySuspendedBridge(
      { data: { bridge: { ...original.state.data.bridge, token: "wrong" } } },
      original.endpointFor,
    ),
  ).rejects.toThrow("refused cleanup");
  expect(original.destroyed()).toBe(false);
});

it("does not claim cleanup when the connection drops after hello", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  servers.push(server);
  server.on("connection", (socket) => {
    socket.send(JSON.stringify({ type: "bridge-hello" }));
    socket.on("message", () => socket.terminate());
  });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No bound port");
  await expect(
    destroySuspendedBridge(
      { data: { bridge: { port: address.port, token: "original" } } },
      async () => ({ url: `ws://127.0.0.1:${address.port}` }),
    ),
  ).rejects.toThrow("refused cleanup");
});
