export function evalIdentityFixture(): Promise<{
  starts: Array<Record<string, unknown>>;
  env: { MCPJAM_API_KEY: string; MCPJAM_API_URL: string };
  close: () => Promise<void>;
}>;
