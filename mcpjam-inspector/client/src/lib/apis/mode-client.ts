import { HOSTED_MODE } from "@/lib/config";

export function isHostedMode(): boolean {
  return HOSTED_MODE;
}

export function ensureLocalMode(message: string): void {
  if (HOSTED_MODE) {
    throw new Error(message);
  }
}

export async function runByMode<T>(options: {
  hosted: () => Promise<T>;
  local: () => Promise<T>;
}): Promise<T> {
  return HOSTED_MODE ? options.hosted() : options.local();
}
