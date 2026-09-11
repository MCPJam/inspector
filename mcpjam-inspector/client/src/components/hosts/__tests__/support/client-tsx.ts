import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

/**
 * The one scan both ratchets run. Different questions, same sweep — two copies
 * could disagree about what "an app file" is and quietly narrow one of them.
 */
export const CLIENT_SRC = join(__dirname, "..", "..", "..", "..");

/** Every app `.tsx` under `client/src`, posix-relative so declarations read the same everywhere. */
export function appTsxFiles(): string[] {
  return readdirSync(CLIENT_SRC, { recursive: true })
    .map(String)
    .filter((f) => f.endsWith(".tsx") && !f.includes("__tests__"))
    .map((f) => f.split("\\").join("/"));
}

export function readAppFile(relative: string): string {
  return readFileSync(join(CLIENT_SRC, relative), "utf8");
}

/** `setParentNodes` on: the in-modal scan walks `node.parent`. */
export function parseTsx(source: string): ts.SourceFile {
  return ts.createSourceFile(
    "f.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
}
