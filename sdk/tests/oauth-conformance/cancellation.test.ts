import { afterEach, describe, expect, it, vi } from "vitest";
import { OAuthConformanceTest } from "../../src/oauth-conformance/index.js";

const serverUrl = "https://mcp.example.com/mcp";
const metadataUrl =
  "https://mcp.example.com/.well-known/oauth-protected-resource/mcp";
const authUrl = "https://auth.example.com";
const json = (body: unknown) => Response.json(body);

afterEach(() => vi.useRealTimers());

describe.each(["metadata", "token"] as const)(
  "OAuth %s cancellation",
  (stage) => {
    it.each(["default", "custom", "step"] as const)(
      "distinguishes %s abort from the other timeout source",
      async (kind) => {
        vi.useFakeTimers();
        const controller = new AbortController();
        const reason = new Error("run cancelled by caller");
        let reachedTarget = false;
        const fetchFn: typeof fetch = async (input, init) => {
          const url = String(input);
          if (
            url === (stage === "metadata" ? metadataUrl : `${authUrl}/token`)
          ) {
            reachedTarget = true;
            expect(init?.signal).toBeDefined();
            return new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener(
                "abort",
                () => reject(init.signal?.reason),
                { once: true }
              );
              if (kind === "default") controller.abort();
              if (kind === "custom") controller.abort(reason);
            });
          }
          if (url === serverUrl)
            return new Response(null, {
              status: 401,
              headers: {
                "WWW-Authenticate": `Bearer resource_metadata="${metadataUrl}"`,
              },
            });
          if (url === metadataUrl)
            return json({
              resource: serverUrl,
              authorization_servers: [authUrl],
            });
          if (url === `${authUrl}/.well-known/oauth-authorization-server`)
            return json({
              issuer: authUrl,
              authorization_endpoint: `${authUrl}/authorize`,
              token_endpoint: `${authUrl}/token`,
              registration_endpoint: `${authUrl}/register`,
              response_types_supported: ["code"],
              grant_types_supported: ["client_credentials"],
              code_challenge_methods_supported: ["S256"],
            });
          if (url === `${authUrl}/register`)
            return json({
              client_id: "client",
              client_secret: "secret",
              token_endpoint_auth_method: "client_secret_post",
            });
          return new Response(null, { status: 404 });
        };
        const run = new OAuthConformanceTest({
          serverUrl,
          protocolVersion: "2025-06-18",
          registrationStrategy: "dcr",
          auth: {
            mode: "client_credentials",
            clientId: "client",
            clientSecret: "secret",
          },
          signal: controller.signal,
          stepTimeout: 100,
          fetchFn,
        }).run();
        if (kind === "step") {
          await vi.runAllTimersAsync();
          const result = await run;
          expect(controller.signal.aborted).toBe(false);
          expect(result.passed).toBe(false);
          expect(JSON.stringify(result.steps)).toContain(
            "Step timed out after 100ms"
          );
        } else {
          if (kind === "custom") await expect(run).rejects.toBe(reason);
          else await expect(run).rejects.toMatchObject({ name: "AbortError" });
        }
        expect(reachedTarget).toBe(true);
      }
    );
  }
);
