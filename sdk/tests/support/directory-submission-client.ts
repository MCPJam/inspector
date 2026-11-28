/** A Platform API client for the directory submission operation tests, answering from a table of routes. */

import { vi } from "vitest";
import { PlatformApiClient } from "../../src/platform/index.js";

export const PROJECT = {
  id: "project-1",
  name: "Acme",
  description: null,
  icon: null,
  organizationId: "org-a",
  visibility: null,
  createdAt: 1,
  updatedAt: 2,
};

export const PROJECT_INFO = { id: "project-1", name: "Acme", organizationId: "org-a" };

const SERVERS = [
  {
    id: "server-1",
    name: "markets",
    projectId: PROJECT.id,
    transportType: "http",
    url: "https://mcp.example.com/mcp",
  },
  { id: "server-2", name: "local", projectId: PROJECT.id, transportType: "stdio" },
];

export const BASE = "/api/v1/projects/project-1/directory-submissions";

type Route = { body: unknown; status?: number };

/** A client whose API answers from `routes` in order, recording each call. */
export function clientWith(routes: Record<string, Route | Route[]>) {
  const requests: Array<{
    key: string;
    query: Record<string, string>;
    body: unknown;
  }> = [];
  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    const key = `${init?.method ?? "GET"} ${url.pathname}`;
    if (key.endsWith("/projects")) return Response.json({ items: [PROJECT] });
    if (key.endsWith("/servers")) return Response.json({ items: SERVERS });
    const queued = routes[key];
    const route = Array.isArray(queued) ? queued.shift() : queued;
    if (!route) throw new Error(`unexpected ${key}`);
    requests.push({
      key,
      query: Object.fromEntries(url.searchParams),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return Response.json(route.body, { status: route.status ?? 200 });
  });
  const client = new PlatformApiClient({
    baseUrl: "https://api.test/api/v1",
    getAuth: () => "t",
    fetch: fetchMock as unknown as typeof fetch,
  });
  return { client, requests };
}
