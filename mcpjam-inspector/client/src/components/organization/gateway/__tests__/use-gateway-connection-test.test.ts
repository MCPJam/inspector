import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebApiError } from "@/lib/apis/web/base";
import { useGatewayConnectionTest } from "../use-gateway-connection-test";

const { webPost, testFromBackend } = vi.hoisted(() => ({
  webPost: vi.fn(),
  testFromBackend: vi.fn(),
}));

vi.mock("convex/react", () => ({ useAction: () => testFromBackend }));
vi.mock("@/lib/apis/web/base", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/apis/web/base")>()),
  webPost,
}));

const ADMINS_ONLY =
  "Only organization admins and owners can test a gateway. Ask an admin to add it.";

function runLocalTest() {
  const { result } = renderHook(() => useGatewayConnectionTest("org_1"));
  return result.current({
    runtimeLocation: "local",
    providerKey: "custom:acme",
    baseUrl: "https://litellm.acme.example",
    secret: "sk-test",
    apis: ["chatCompletions"],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useGatewayConnectionTest from this Inspector", () => {
  it("names the organization so the server can check the caller's role", async () => {
    webPost.mockResolvedValue({ reachable: true, origin: "inspector" });

    await runLocalTest();

    expect(webPost).toHaveBeenCalledWith("/api/web/org-gateway-test", {
      organizationId: "org_1",
      baseUrl: "https://litellm.acme.example",
      secret: "sk-test",
      apis: ["chatCompletions"],
    });
    expect(testFromBackend).not.toHaveBeenCalled();
  });

  it("shows the server's refusal where test failures show", async () => {
    webPost.mockRejectedValue(new WebApiError(403, "FORBIDDEN", ADMINS_ONLY));

    await expect(runLocalTest()).resolves.toEqual({ error: ADMINS_ONLY });
  });
});
