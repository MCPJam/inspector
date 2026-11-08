/**
 * A pass-through in front of the e2e's mock model upstream that keeps every
 * JSON request body the vendor CLI sends. The mock answers as before; the test
 * reads what actually reached the model.
 */
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null;

export async function startRecordingProxy(target: string) {
  const bodies: unknown[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      try {
        bodies.push(JSON.parse(body.toString("utf8")));
      } catch {
        // Not a JSON request (a model list, for one): nothing to record.
      }
      const headers = { ...req.headers, "content-length": String(body.length) };
      delete headers.host;
      delete headers.connection;
      delete headers["transfer-encoding"];
      const forwarded = request(
        new URL(req.url ?? "/", target),
        { method: req.method, headers },
        (upstream) => {
          res.writeHead(upstream.statusCode ?? 502, upstream.headers);
          upstream.pipe(res);
        },
      );
      forwarded.on("error", () => res.destroy());
      forwarded.end(body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    bodies,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * `<media type>:<base64 length>` for each image in a user message of the
 * recorded requests: Anthropic `image` blocks and Responses `input_image` parts.
 */
export function imagesSent(bodies: unknown[]): string[] {
  const sent: string[] = [];
  for (const body of bodies) {
    if (!isRecord(body)) continue;
    const items = [body.messages, body.input].flatMap((list) =>
      Array.isArray(list) ? list : [],
    );
    for (const item of items) {
      if (!isRecord(item) || item.role !== "user") continue;
      for (const part of Array.isArray(item.content) ? item.content : []) {
        if (!isRecord(part)) continue;
        if (part.type === "image" && isRecord(part.source)) {
          sent.push(
            `${String(part.source.media_type)}:${String(part.source.data).length}`,
          );
        } else if (part.type === "input_image") {
          const url = /^data:([^;]+);base64,(.*)$/s.exec(String(part.image_url));
          sent.push(url ? `${url[1]}:${url[2]!.length}` : "not-a-data-url");
        }
      }
    }
  }
  return sent;
}
