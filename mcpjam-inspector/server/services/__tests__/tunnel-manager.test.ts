import { afterEach, describe, expect, it, vi } from "vitest";
import { isActiveTunnelDomain } from "../tunnel-registry";

const relayMock = vi.hoisted(() => {
  type ConnectImpl = (conn: MockRelayConnection) => Promise<void> | void;

  let connectImpl: ConnectImpl = async (conn) => {
    conn.connected = true;
  };
  const instances: MockRelayConnection[] = [];

  class MockRelayConnection {
    connected = false;
    closed = false;
    permanentFailure: string | null = null;

    constructor(readonly options: any) {
      instances.push(this);
    }

    get isConnected(): boolean {
      return this.connected;
    }

    async connect(): Promise<void> {
      await connectImpl(this);
    }

    close(): void {
      this.closed = true;
      this.connected = false;
    }
  }

  return {
    RelayConnection: MockRelayConnection,
    instances,
    reset() {
      instances.length = 0;
      connectImpl = async (conn) => {
        conn.connected = true;
      };
    },
    setConnectImpl(fn: ConnectImpl) {
      connectImpl = fn;
    },
  };
});

vi.mock("../relay-client", () => ({
  RelayConnection: relayMock.RelayConnection,
}));

const { tunnelManager } = await import("../tunnel-manager");

const options = {
  localAddr: "http://localhost:6274",
  slug: "testslug0001",
  relayWsUrl: "wss://agent.tunnels.mcpjam.com/agent",
  connectToken: "test-connect-token",
  publicUrl:
    "https://testslug0001.tunnels.mcpjam.com/api/mcp/adapter-http/test-server?k=secret",
  secretVersion: 1,
};

describe("TunnelManager", () => {
  afterEach(async () => {
    await tunnelManager.closeAll();
    relayMock.reset();
  });

  it("registers a connected relay tunnel", async () => {
    await expect(
      tunnelManager.createTunnel("test-server", options)
    ).resolves.toBe("https://testslug0001.tunnels.mcpjam.com");

    expect(tunnelManager.getServerTunnelUrl("test-server")).toBe(
      options.publicUrl
    );
    expect(isActiveTunnelDomain("testslug0001.tunnels.mcpjam.com")).toBe(true);
  });

  it("does not store a tunnel when the relay closes permanently before registration", async () => {
    relayMock.setConnectImpl(async (conn) => {
      conn.connected = false;
      conn.permanentFailure = "Tunnel taken over by another inspector instance";
      conn.options.onPermanentFailure?.(conn.permanentFailure, 4001);
    });

    await expect(
      tunnelManager.createTunnel("test-server", options)
    ).rejects.toThrow(/another inspector/i);

    expect(tunnelManager.getServerTunnelUrl("test-server")).toBeNull();
    expect(isActiveTunnelDomain("testslug0001.tunnels.mcpjam.com")).toBe(false);
    expect(relayMock.instances[0]?.closed).toBe(true);
  });
});
