import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { EnvironmentOverrides } from "@/shared/execution-target";
import { useEnvironmentTools } from "../use-environment-tools";

const { fetchTools } = vi.hoisted(() => ({
  fetchTools: vi.fn<typeof fetch>(),
}));
vi.mock("@/lib/session-token", () => ({ authFetch: fetchTools }));
vi.mock("@/hooks/useProjects", () => ({ shouldQueryProjectId: () => true }));

it("does not show inherited tools after the same pane turns its servers off", async () => {
  const delayed = Promise.withResolvers<Response>();
  fetchTools
    .mockReturnValueOnce(delayed.promise)
    .mockResolvedValueOnce(Response.json({ servers: [] }));
  const { result, rerender } = renderHook(
    ({ overrides }: { overrides?: EnvironmentOverrides }) =>
      useEnvironmentTools("project", "same", 1, overrides),
    { initialProps: { overrides: undefined } },
  );
  expect(fetchTools.mock.calls[0]).toEqual([
    "/api/web/environments/same/tools?projectId=project",
  ]);
  rerender({ overrides: { serverIds: [], pluginVersionIds: [] } });
  await waitFor(() => expect(result.current.servers).toEqual([]));
  expect(fetchTools.mock.calls[1][1]).toMatchObject({
    method: "POST",
    body: JSON.stringify({ serverIds: [], pluginVersionIds: [] }),
  });
  await act(async () =>
    delayed.resolve(
      Response.json({
        servers: [{ serverId: "disabled", tools: [{ name: "old" }] }],
      }),
    ),
  );
  expect(result.current.servers).toEqual([]);
});
