import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchConfidentialCimdClientUrlMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/config", () => ({ HOSTED_MODE: true }));
vi.mock("@/lib/xaa/idp-endpoints", () => ({
  fetchConfidentialCimdClientUrl: fetchConfidentialCimdClientUrlMock,
}));

import { useConfidentialCimdCapability } from "../use-confidential-cimd-capability";

describe("useConfidentialCimdCapability in hosted mode", () => {
  beforeEach(() => {
    fetchConfidentialCimdClientUrlMock.mockReset();
  });

  it("does not probe for guests or users without an organization", () => {
    const { result, rerender } = renderHook(
      (props: { organizationId?: string; isSignedIn: boolean }) =>
        useConfidentialCimdCapability({ enabled: true, ...props }),
      { initialProps: { organizationId: undefined, isSignedIn: true } }
    );

    expect(result.current.status).toBe("unavailable");
    expect(fetchConfidentialCimdClientUrlMock).not.toHaveBeenCalled();

    rerender({ organizationId: "org-1", isSignedIn: false });
    expect(result.current.status).toBe("unavailable");
    expect(fetchConfidentialCimdClientUrlMock).not.toHaveBeenCalled();
  });

  it("clears the previous org identity while probing the next org", async () => {
    let resolveOrgTwo: ((value: string | null) => void) | undefined;
    fetchConfidentialCimdClientUrlMock
      .mockResolvedValueOnce("https://app.mcpjam.com/cimd/org-1")
      .mockImplementationOnce(
        () =>
          new Promise<string | null>((resolve) => {
            resolveOrgTwo = resolve;
          })
      );

    const { result, rerender } = renderHook(
      (props: { organizationId: string }) =>
        useConfidentialCimdCapability({
          enabled: true,
          organizationId: props.organizationId,
          isSignedIn: true,
        }),
      { initialProps: { organizationId: "org-1" } }
    );

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.clientIdMetadataUrl).toContain("org-1");

    rerender({ organizationId: "org-2" });
    expect(result.current.status).toBe("loading");
    expect(result.current.clientIdMetadataUrl).toBeUndefined();

    act(() => resolveOrgTwo?.("https://app.mcpjam.com/cimd/org-2"));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.clientIdMetadataUrl).toContain("org-2");
    expect(fetchConfidentialCimdClientUrlMock).toHaveBeenLastCalledWith({
      organizationId: "org-2",
      signal: expect.any(AbortSignal),
    });
  });

  it("fails closed on probe errors and retries on demand", async () => {
    fetchConfidentialCimdClientUrlMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce("https://app.mcpjam.com/cimd/org-1");

    const { result } = renderHook(() =>
      useConfidentialCimdCapability({
        enabled: true,
        organizationId: "org-1",
        isSignedIn: true,
      })
    );

    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.available).toBe(false);

    act(() => result.current.retry());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.available).toBe(true);
    expect(fetchConfidentialCimdClientUrlMock).toHaveBeenCalledTimes(2);
  });
});
