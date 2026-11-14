import { expect } from "@playwright/test";

/** Mint the same single-use stream credential the UI requests. */
export async function frameStreamNonce(
  token: string,
  sessionId: string,
  base: string,
  headers: Record<string, string>,
): Promise<string> {
  const response = await fetch(
    `${base}/api/mcp/webmcp/sessions/${sessionId}/stream-nonce`,
    { method: "POST", headers },
  );
  expect(response.status, "stream nonce must authorize this session").toBe(200);
  const body: { nonce: string } = await response.json();
  expect(body.nonce).toBeTruthy();
  expect(body.nonce).not.toBe(token);
  return body.nonce;
}
