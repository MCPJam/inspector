import { fileURLToPath } from "url";
import { dirname, join } from "path";
import fs from "fs/promises";
import sharp from "sharp";
import pngToIco from "png-to-ico";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function generateWindowsIcon() {
  const projectRoot = join(__dirname, "..");
  const svgPath = join(projectRoot, "client", "public", "mcp_jam.svg");
  const tmpDir = join(projectRoot, ".icon-tmp");
  const outDir = join(projectRoot, "assets");
  const outIco = join(outDir, "icon.ico");

  await ensureDir(tmpDir);
  await ensureDir(outDir);

  const sizes = [256, 128, 64, 48, 32, 16];
  const pngPaths = [];

  for (const size of sizes) {
    const outPng = join(tmpDir, `icon-${size}.png`);
    await sharp(svgPath)
      .resize(size, size, {
        fit: "contain",
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .png()
      .toFile(outPng);
    pngPaths.push(outPng);
  }

  const icoBuffer = await pngToIco(pngPaths);
  await fs.writeFile(outIco, icoBuffer);

  // Cleanup temporary PNGs
  try {
    await fs.rm(tmpDir, { recursive: true, force: true });
  } catch {}

  console.log(`Generated ${outIco}`);
}

generateWindowsIcon().catch((err) => {
  console.error("Failed to generate Windows icon:", err);
  process.exit(1);
});
