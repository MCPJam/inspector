import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

/**
 * The one scan both ratchets run.
 *
 * `server-picker-inventory` asks which files render a clickable server list;
 * `server-picker-in-modal-contract` asks which pickers sit inside a dialog.
 * Different questions, same sweep — and while each owned a copy of it they
 * could silently disagree about what "an app file" is, which would make one
 * ratchet quietly narrower than the suite it reports for.
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

/**
 * Parse as TSX, `setParentNodes` on — the in-modal scan walks `node.parent` to
 * find an enclosing `<DialogContent>`, which is undefined without it.
 */
export function parseTsx(source: string): ts.SourceFile {
  return ts.createSourceFile(
    "f.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
}
