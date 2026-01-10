import { fileURLToPath } from "url";
import { dirname, join } from "path";
import fs from "fs/promises";
import { execFile } from "child_process";
import sharp from "sharp";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        return reject(err);
      }
      resolve({ stdout, stderr });
    });
  });
}

async function generateMacIcon() {
  if (process.platform !== "darwin") {
    console.log("Skipping mac icon generation: not running on macOS");
    return;
  }

  const projectRoot = join(__dirname, "..");
  const svgPath = join(projectRoot, "client", "public", "mcp_jam.svg");
  const iconsetDir = join(projectRoot, ".iconset-tmp", "icon.iconset");
  const outDir = join(projectRoot, "assets");
  const outIcns = join(outDir, "icon.icns");

  const sizes = [
    [16, "icon_16x16.png"],
    [32, "icon_16x16@2x.png"],
    [32, "icon_32x32.png"],
    [64, "icon_32x32@2x.png"],
    [128, "icon_128x128.png"],
    [256, "icon_128x128@2x.png"],
    [256, "icon_256x256.png"],
    [512, "icon_256x256@2x.png"],
    [512, "icon_512x512.png"],
    [1024, "icon_512x512@2x.png"],
  ];

  await ensureDir(iconsetDir);
  await ensureDir(outDir);

  for (const [size, name] of sizes) {
    // Scale down content to 85% to add padding (like other macOS icons)
    const contentSize = Math.round(size * 0.85);
    const padding = Math.round((size - contentSize) / 2);

    await sharp(svgPath)
      .resize(contentSize, contentSize, {
        fit: "contain",
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .extend({
        top: padding,
        bottom: padding,
        left: padding,
        right: padding,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .png()
      .toFile(join(iconsetDir, name));
  }

  // Convert iconset to .icns using macOS iconutil
  await run("iconutil", ["-c", "icns", iconsetDir, "-o", outIcns]);

  // Cleanup
  try {
    await fs.rm(dirname(iconsetDir), { recursive: true, force: true });
  } catch {}

  console.log(`Generated ${outIcns}`);
}

generateMacIcon().catch((err) => {
  console.error("Failed to generate macOS .icns icon:", err?.stderr || err);
  process.exit(1);
});
