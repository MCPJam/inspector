import { createServer } from "http";

export function findAvailablePort(startPort = 3500): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, () => {
      const port = (server.address() as any)?.port;
      server.close(() => {
        resolve(port || startPort);
      });
    });
    server.on("error", () => {
      resolve(startPort);
    });
  });
}
