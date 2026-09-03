import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";

/**
 * A stand-in for the third-party API an MCP App view calls — the Google Maps
 * of the scenario that drove real-URL views.
 *
 * Its whole job is to record what the browser told it about the caller. A
 * referrer-restricted API key is checked against exactly that, so a fixture
 * that answers unconditionally and remembers the `Referer` is a truer oracle
 * than asserting on anything the page reports about itself.
 *
 * Note the recorded `Referer` is governed by the SENDING document's referrer
 * policy, which nothing here can influence — a response header on this fixture
 * would only affect requests made from its own responses.
 */
export interface ViewFixtureRequest {
  path: string;
  /** What the browser said the calling page was. */
  referer?: string;
  /** The caller's origin, which is what CORS-based allowlists key on. */
  origin?: string;
}

export interface ViewFixtureServer {
  origin: string;
  requests: ViewFixtureRequest[];
  close: () => Promise<void>;
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function startViewFixtureServer(): Promise<ViewFixtureServer> {
  const requests: ViewFixtureRequest[] = [];

  const server = http.createServer(
    (request: IncomingMessage, response: ServerResponse) => {
      const url = new URL(
        request.url ?? "/",
        `http://${request.headers.host ?? "127.0.0.1"}`,
      );

      if (request.method === "OPTIONS") {
        response.writeHead(204, CORS_HEADERS);
        response.end();
        return;
      }

      requests.push({
        path: url.pathname,
        referer: request.headers.referer,
        origin: request.headers.origin,
      });

      response.writeHead(200, {
        ...CORS_HEADERS,
        "Content-Type": "application/json",
      });
      response.end(JSON.stringify({ ok: true }));
    },
  );

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("View fixture server did not receive a TCP address");
  }

  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    close: async () => {
      server.close();
      await once(server, "close");
    },
  };
}
