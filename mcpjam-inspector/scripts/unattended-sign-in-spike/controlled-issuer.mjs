import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

export function totp(key, step, digits = 6) {
  const count = Buffer.alloc(8);
  count.writeBigUInt64BE(BigInt(step));
  const mac = createHmac("sha1", key).update(count).digest();
  const offset = mac[mac.length - 1] & 15;
  const truncated = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(truncated % 10 ** digits).padStart(digits, "0");
}
export const currentStep = () => Math.floor(Date.now() / 30000);

export async function startIssuer({ seat, password, seed, ttlMs }) {
  const passwordHash = createHash("sha256").update(password).digest();
  const challenges = new Map();
  const sessions = new Map();
  const evidence = { passwords: 0, acceptedSteps: [], toolCalls: [] };
  let nextHuman = false;
  const http = createServer(async (req, res) => {
    try {
      const path = req.url;
      const cookies = Object.fromEntries(
        (req.headers.cookie || "")
          .split("; ")
          .filter(Boolean)
          .map((pair) => pair.split("=")),
      );
      const redirect = (to, cookie) => {
        res.writeHead(303, {
          Location: to,
          ...(cookie ? { "Set-Cookie": cookie } : {}),
        });
        res.end();
      };
      const html = (markup) => {
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "Content-Security-Policy":
            "default-src 'none'; form-action 'self'; frame-ancestors 'none'",
        });
        res.end(markup);
      };
      const form = (path, input) =>
        '<form method="post" action="' +
        path +
        '">' +
        input +
        "<button>Continue</button></form>";
      const signedIn = (sessions.get(cookies.auth) ?? 0) > Date.now();
      if (req.method === "GET") {
        if (path === "/login")
          return html(
            form("/password", '<input name="password" type="password">'),
          );
        if (path === "/challenge")
          return html(
            form("/verify", '<input name="code" autocomplete="one-time-code">'),
          );
        if (path === "/home")
          return signedIn
            ? html('<p data-testid="identity">' + seat + "</p>")
            : redirect("/login");
        if (path === "/human") return html("Human verification required");
        if (path === "/denied") return html("Authentication denied");
      }
      if (
        req.method === "POST" &&
        (path === "/password" || path === "/verify")
      ) {
        let body = "";
        for await (const part of req) {
          body += part;
          if (body.length > 2048) throw new Error("Body too large");
        }
        const data = new URLSearchParams(body);
        if (path === "/password") {
          evidence.passwords++;
          const candidate = createHash("sha256")
            .update(data.get("password") || "")
            .digest();
          if (!timingSafeEqual(candidate, passwordHash))
            return redirect("/denied");
          if (nextHuman) {
            nextHuman = false;
            return redirect("/human");
          }
          const challenge = randomBytes(24).toString("hex");
          challenges.set(challenge, Date.now() + 60000);
          return redirect(
            "/challenge",
            "challenge=" + challenge + "; HttpOnly; SameSite=Strict; Path=/",
          );
        }
        const expiry = challenges.get(cookies.challenge) ?? 0;
        challenges.delete(cookies.challenge);
        const step = currentStep();
        const code = data.get("code") || "";
        if (
          expiry <= Date.now() ||
          evidence.acceptedSteps.includes(step) ||
          !/^\d{6}$/.test(code) ||
          !timingSafeEqual(Buffer.from(code), Buffer.from(totp(seed, step)))
        )
          return redirect("/denied");
        evidence.acceptedSteps.push(step);
        const token = randomBytes(24).toString("hex");
        sessions.set(token, Date.now() + ttlMs);
        return redirect(
          "/home",
          "auth=" + token + "; HttpOnly; SameSite=Strict; Path=/",
        );
      }
      if (req.method === "POST" && path === "/mcp") {
        if (!signedIn) {
          res.writeHead(401);
          return res.end();
        }
        const mcp = new McpServer({
          name: "renewal-fixture",
          version: "1.0.0",
        });
        mcp.tool(
          "echo",
          "Echo a test marker",
          { text: z.string() },
          async ({ text }) => {
            evidence.toolCalls.push(text);
            return { content: [{ type: "text", text: "echo: " + text }] };
          },
        );
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        res.on("close", () => {
          void mcp.close();
        });
        await mcp.connect(transport);
        return await transport.handleRequest(req, res);
      }
      res.writeHead(404);
      res.end();
    } catch {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  return {
    origin: "http://127.0.0.1:" + http.address().port,
    evidence,
    requirePerson: () => {
      nextHuman = true;
    },
    close: async () => {
      const done = once(http, "close");
      http.close();
      http.closeAllConnections();
      await done;
    },
  };
}
