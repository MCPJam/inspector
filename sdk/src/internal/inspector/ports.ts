import { createServer } from "node:net";
import { operationalError } from "./errors.js";

export const DEFAULT_INSPECTOR_PORT = 6274;
/** How many ports after the preferred one a launch tries before giving up. */
export const PORT_SCAN_WINDOW = 20;

/** True when nothing listens on the port on the loopback address. */
export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

/**
 * The preferred port when free, else the next free one within
 * {@link PORT_SCAN_WINDOW}. With `strictPort`, a taken preferred port fails
 * instead, the way Vite, Storybook and Expo do.
 */
export async function choosePort(options: {
  preferred: number;
  strictPort?: boolean;
  isFree?: (port: number) => Promise<boolean>;
}): Promise<number> {
  const isFree = options.isFree ?? isPortFree;
  const { preferred } = options;
  if (await isFree(preferred)) return preferred;
  if (options.strictPort) {
    throw operationalError(
      `Port ${preferred} is in use. Free it, or launch without strictPort to use the next free port.`,
    );
  }
  const last = Math.min(preferred + PORT_SCAN_WINDOW, 65_535);
  for (let port = preferred + 1; port <= last; port += 1) {
    if (await isFree(port)) return port;
  }
  throw operationalError(
    `Ports ${preferred} to ${last} are all in use. Free one, or pass another port.`,
  );
}
