import net from "node:net";

/** Probe the same address the child will bind, including wildcard conflicts. */
export function availableListenerPort(host: "127.0.0.1" | "0.0.0.0"): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("The port probe has no TCP address.")));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}
