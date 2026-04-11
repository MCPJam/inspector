import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { operationalError } from "./output";

export async function writeDebugArtifact(
  outputPath: string,
  payload: unknown,
): Promise<string> {
  const resolvedPath = path.resolve(process.cwd(), outputPath);

  try {
    await mkdir(path.dirname(resolvedPath), { recursive: true });
    await writeFile(
      resolvedPath,
      `${JSON.stringify(payload, null, 2)}\n`,
      "utf8",
    );
  } catch (error) {
    throw operationalError(
      `Failed to write debug artifact to "${resolvedPath}".`,
      {
        source: error instanceof Error ? error.message : String(error),
      },
    );
  }

  return resolvedPath;
}
