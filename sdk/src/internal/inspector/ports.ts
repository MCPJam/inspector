import { createServer } from "node:net";
import { operationalError } from "./errors.js";

export const DEFAULT_INSPECTOR_PORT = 6274;
/** How many ports after the preferred one a launch tries before giving up. */
export const PORT_SCAN_WINDOW = 20;

/** Hosts a listener may hold the port on and still make `localhost` ambiguous. */
const PROBE_HOSTS = ["127.0.0.1", "::1"];
/** No such address on this machine (for example, IPv6 is off): not a listener. */
const NO_SUCH_ADDRESS = new Set(["EADDRNOTAVAIL", "EAFNOSUPPORT"]);

function bindsFree(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", (error: NodeJS.ErrnoException) =>
      resolve(NO_SUCH_ADDRESS.has(error.code ?? "")),
    );
    server.listen(port, host, () => {
      server.close(() => resolve(true));
    });
  });
}

/**
 * True when nothing listens on the port on the loopback addresses. Both
 * `127.0.0.1` and `::1` are tried: on macOS a listener on `::`, `::1` or
 * `0.0.0.0` does not stop a bind to `127.0.0.1`, and the `localhost` link we
 * hand out could then resolve to the other program.
 */
export async function isPortFree(port: number): Promise<boolean> {
  for (const host of PROBE_HOSTS) {
    if (!(await bindsFree(port, host))) return false;
  }
  return true;
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
