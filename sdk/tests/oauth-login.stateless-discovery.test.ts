import { expect, it } from "vitest";
import { resolveOAuthLoginAuthorizationPlan } from "../src/oauth-login.js";

const server = "https://mcp.example.com/mcp";
const issuer = "https://auth.example.com";
const standard =
  "https://mcp.example.com/.well-known/oauth-protected-resource/mcp";
const advertised = "https://mcp.example.com/custom-metadata";

it.each([standard, advertised])(
  "plans 2026 login using %s",
  async (pointer) => {
    const methods: string[] = [];
    const requests: string[] = [];
    const fetchFn: typeof fetch = async (input, init) => {
      const url = String(input);
      requests.push(url);
      if (url === server) {
        const body = JSON.parse(String(init?.body));
        methods.push(body.method);
        expect(new Headers(init?.headers).get("MCP-Protocol-Version")).toBe(
          "2026-07-28"
        );
        expect(new Headers(init?.headers).get("Mcp-Method")).toBe("tools/list");
        expect(
          body.params._meta["io.modelcontextprotocol/protocolVersion"]
        ).toBe("2026-07-28");
        return new Response(null, {
          status: 401,
          headers: {
            "WWW-Authenticate": `Bearer resource_metadata="${advertised}"`,
          },
        });
      }
      if (url === pointer) {
        return Response.json({
          resource: server,
          authorization_servers: [issuer],
        });
      }
      if (url === issuer + "/.well-known/oauth-authorization-server") {
        return Response.json({
          issuer,
          registration_endpoint: issuer + "/register",
        });
      }
      return new Response(null, { status: 404 });
    };
    const plan = await resolveOAuthLoginAuthorizationPlan({
      serverUrl: server,
      protocolVersion: "2026-07-28",
      fetchFn,
    });
    expect(plan.registrationStrategy).toBe("dcr");
    expect(requests[0]).toBe(standard);
    expect(methods).toEqual(pointer === standard ? [] : ["tools/list"]);
  }
);
