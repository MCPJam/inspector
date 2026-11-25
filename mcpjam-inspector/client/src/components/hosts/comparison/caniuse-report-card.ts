import { clientBadges, groupResults } from "./CaniuseClientMap";
import { clientLogo } from "./CaniuseSite";
import type { CapabilityCoverage } from "./caniuse-coverage";

export const CARD_WIDTH = 1200;
export const CARD_HEIGHT = 630;
const INSET = 48;

async function loadImage(path: string): Promise<HTMLImageElement | null> {
  const image = new Image();
  image.src = path;
  try {
    await image.decode();
    return image;
  } catch {
    return null;
  }
}

function drawImage(
  ctx: CanvasRenderingContext2D,
  image: HTMLImageElement,
  x: number,
  y: number,
  width: number,
  height: number,
) {
  const scale = Math.min(
    width / image.naturalWidth,
    height / image.naturalHeight,
  );
  const w = image.naturalWidth * scale;
  const h = image.naturalHeight * scale;
  ctx.drawImage(image, x + (width - w) / 2, y + (height - h) / 2, w, h);
}

export function shareResultLabel(
  status: string,
  count: number,
  reporting: boolean,
) {
  if (status === "supported") {
    if (reporting)
      return count === 1 ? "1 reports a value" : `${count} report a value`;
    return count === 1 ? "1 supports" : `${count} support`;
  }
  if (status === "unsupported" && reporting)
    return count === 1 ? "1 didn’t report a value" : `${count} didn’t report a value`;
  if (status === "unsupported")
    return count === 1 ? "1 doesn’t support" : `${count} don’t support`;
  return `${count} with partial support`;
}

export async function drawCaniuseReportCard(
  canvas: HTMLCanvasElement,
  title: string,
  slice: string,
  coverage: CapabilityCoverage,
  signal: AbortSignal,
) {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas unavailable");
  const styles = getComputedStyle(canvas);
  const color = (name: string) => styles.getPropertyValue(name).trim();
  const font = (weight: number, size: number) => {
    ctx.font = `${weight} ${size}px "Caniuse Instrument Sans", sans-serif`;
  };
  const text = (
    value: string,
    x: number,
    y: number,
    tint = "--foreground",
    maxWidth?: number,
  ) => {
    ctx.fillStyle = color(tint);
    ctx.fillText(value, x, y, maxWidth);
  };
  const fill = (
    x: number,
    y: number,
    w: number,
    h: number,
    radius: number,
    tint: string,
  ) => {
    ctx.fillStyle = color(tint);
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, radius);
    ctx.fill();
  };
  const groups = groupResults(coverage);
  const shown = groups.filter(
    ({ clients, status }) => status !== "unknown" && clients.length > 0,
  );
  const logos = new Map(
    shown.flatMap(({ clients }) =>
      clients.map((client) => [clientLogo(client), null] as const),
    ),
  );
  const [wordmark, images] = await Promise.all([
    loadImage("/mcp_jam_dark.png"),
    Promise.all(
      [...logos.keys()].map(
        async (src) => [src, await loadImage(src)] as const,
      ),
    ),
    document.fonts.ready,
  ]);
  if (signal.aborted) return;
  const imageBySrc = new Map(images);

  fill(0, 0, CARD_WIDTH, CARD_HEIGHT, 0, "--background");
  const glow = ctx.createRadialGradient(1060, -45, 0, 1060, -45, 550);
  glow.addColorStop(0, color("--primary"));
  glow.addColorStop(1, "transparent");
  ctx.fillStyle = glow;
  ctx.globalAlpha = 0.2;
  ctx.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT);
  ctx.globalAlpha = 1;

  font(600, 23);
  text("CAN I USE MCP", INSET, 57, "--muted-foreground");
  font(700, 53);
  text(title, INSET, 122, "--foreground", 900);
  font(500, 24);
  if (slice) text(slice, INSET, 157, "--muted-foreground");
  font(600, 22);
  if (!shown.length)
    text("No published client results yet.", INSET, 223, "--muted-foreground");
  ctx.textAlign = "right";
  font(700, 72);
  text(
    coverage.score === null ? "—" : `${coverage.score}%`,
    CARD_WIDTH - INSET,
    109,
    "--primary",
  );
  font(600, 22);
  text(
    coverage.reporting ? "Reporting coverage" : "Client adoption",
    CARD_WIDTH - INSET,
    147,
    "--muted-foreground",
  );
  ctx.textAlign = "left";

  const largest = Math.max(0, ...shown.map(({ clients }) => clients.length));
  const tileWidth = largest > 24 ? 66 : largest > 12 ? 76 : 84;
  const gap = 11;
  const columns = Math.floor(
    (CARD_WIDTH - 2 * INSET + gap) / (tileWidth + gap),
  );
  const rows = shown.reduce(
    (sum, { clients }) => sum + Math.ceil(clients.length / columns),
    0,
  );
  const tileHeight = Math.min(
    76,
    Math.floor(
      (370 - 55 * shown.length - 8 * (rows - shown.length)) / Math.max(1, rows),
    ),
  );
  let y =
    174 +
    Math.max(
      0,
      Math.floor(
        (370 -
          55 * shown.length -
          8 * (rows - shown.length) -
          tileHeight * rows) /
          2,
      ),
    );
  for (const { status, clients, token } of shown) {
    const label = shareResultLabel(status, clients.length, coverage.reporting);
    font(600, 20);
    ctx.globalAlpha = 0.28;
    fill(INSET, y, ctx.measureText(label).width + 52, 32, 16, token);
    ctx.globalAlpha = 1;
    font(700, 21);
    text(
      status === "supported" ? "✓" : status === "unsupported" ? "×" : "−",
      INSET + 12,
      y + 23,
    );
    font(600, 20);
    text(label, INSET + 36, y + 22);
    const top = y + 41;
    clients.forEach((client, index) => {
      const x = INSET + (index % columns) * (tileWidth + gap);
      const rowY = top + Math.floor(index / columns) * (tileHeight + 8);
      fill(x, rowY, tileWidth, tileHeight, 8, "--card");
      const badge = clientBadges(client, coverage)
        .join(" ")
        .replace("Desktop", "Desk");
      const image = imageBySrc.get(clientLogo(client));
      const logoHeight = Math.min(43, tileHeight - (badge ? 20 : 10));
      const logoY = rowY + (badge ? 3 : (tileHeight - logoHeight) / 2);
      if (image)
        drawImage(
          ctx,
          image,
          x + (tileWidth - logoHeight) / 2,
          logoY,
          logoHeight,
          logoHeight,
        );
      else {
        font(600, 17);
        ctx.textAlign = "center";
        text(
          client.hostName,
          x + tileWidth / 2,
          logoY + logoHeight / 2 + 6,
          "--foreground",
          tileWidth - 8,
        );
        ctx.textAlign = "left";
      }
      if (badge) {
        font(600, 12);
        const width = Math.min(
          tileWidth - 6,
          ctx.measureText(badge).width + 10,
        );
        fill(
          x + (tileWidth - width) / 2,
          rowY + tileHeight - 19,
          width,
          15,
          4,
          "--muted",
        );
        ctx.textAlign = "center";
        text(
          badge,
          x + tileWidth / 2,
          rowY + tileHeight - 7,
          "--muted-foreground",
          width - 6,
        );
        ctx.textAlign = "left";
      }
    });
    y = top + Math.ceil(clients.length / columns) * (tileHeight + 8) + 6;
  }

  font(500, 19);
  const unknown =
    groups.find(({ status }) => status === "unknown")?.clients.length ?? 0;
  text(
    unknown
      ? `caniuse.dev   ·   ${unknown} without a published result`
      : "caniuse.dev",
    INSET,
    587,
    "--muted-foreground",
  );
  if (wordmark)
    drawImage(ctx, wordmark, CARD_WIDTH - INSET - 152, 557, 152, 39);
  else {
    ctx.textAlign = "right";
    font(700, 30);
    text("MCPJam", CARD_WIDTH - INSET, 584);
  }
}
