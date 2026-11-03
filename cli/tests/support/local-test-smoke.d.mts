type CliRun = { exitCode: number | null; stdout: string; stderr: string };

/** A minimal Anthropic Messages API: call read_note once, then answer. */
export function startAnthropicStub(): Promise<{
  baseUrl: string;
  requests: Array<{ url?: string; headers: Record<string, unknown>; body: string }>;
  close: () => Promise<void>;
}>;

export function runLocalTestSmoke(options: {
  cliEntry: string;
  fixturePath: string;
  workDir: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{
  full: CliRun;
  rerun: CliRun;
  requests: unknown[];
  starts: Array<Record<string, unknown>>;
}>;
