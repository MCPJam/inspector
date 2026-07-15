// Copy package-owned CSS into dist so consumers can `import
// "@mcpjam/chat-ui/styles.css"`. tsup only emits the JS/d.ts bundle; the
// stylesheet is shipped as-is.
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const src = join(root, "src", "styles.css");
const distDir = join(root, "dist");
const dest = join(distDir, "styles.css");

if (!existsSync(src)) {
  console.error(`[copy-css] missing source stylesheet: ${src}`);
  process.exit(1);
}
mkdirSync(distDir, { recursive: true });
copyFileSync(src, dest);
console.log(`[copy-css] ${src} -> ${dest}`);
