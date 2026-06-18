/**
 * Dependency-free inline-image rendering for terminals that support a graphics
 * protocol. Two protocols cover the common emulators:
 *
 *  - iTerm2's inline-image protocol (OSC 1337) — iTerm2, WezTerm.
 *  - Kitty's graphics protocol (APC _G) — Kitty, Ghostty.
 *
 * Callers detect support first; when no protocol is available they fall back to
 * printing the image URL instead. We never emit escape sequences to a
 * non-interactive stream (pipes, CI), so structured/JSON output stays clean.
 */

export type InlineImageProtocol = "iterm" | "kitty";

const ESC = "\x1b";
const BEL = "\x07";

/**
 * Decide which inline-image protocol the current terminal supports, if any.
 * Returns null when output is not an interactive TTY or the emulator is
 * unknown — the caller should then print the URL.
 */
export function detectInlineImageProtocol(
  env: NodeJS.ProcessEnv = process.env,
  isTTY: boolean | undefined = process.stdout.isTTY,
): InlineImageProtocol | null {
  if (!isTTY) return null;

  const termProgram = env.TERM_PROGRAM ?? "";
  const term = env.TERM ?? "";

  // Kitty graphics protocol: Kitty itself and Ghostty.
  if (
    term === "xterm-kitty" ||
    env.KITTY_WINDOW_ID !== undefined ||
    termProgram === "ghostty" ||
    env.GHOSTTY_RESOURCES_DIR !== undefined
  ) {
    return "kitty";
  }

  // iTerm2 inline-image protocol: iTerm2 and WezTerm.
  if (
    termProgram === "iTerm.app" ||
    termProgram === "WezTerm" ||
    env.LC_TERMINAL === "iTerm2"
  ) {
    return "iterm";
  }

  return null;
}

function toBase64(data: Uint8Array): string {
  return Buffer.from(data).toString("base64");
}

/** iTerm2 OSC 1337 inline image: a single escape carrying the whole payload. */
function encodeIterm(data: Uint8Array): string {
  const payload = toBase64(data);
  const args = ["inline=1", `size=${data.byteLength}`, "preserveAspectRatio=1"].join(
    ";",
  );
  // ESC ] 1337 ; File=<args> : <base64> BEL
  return `${ESC}]1337;File=${args}:${payload}${BEL}\n`;
}

/**
 * Kitty graphics protocol: transmit-and-display a PNG (f=100, a=T), chunking
 * the base64 payload at 4096 bytes. Only the first chunk carries the format /
 * action keys; every chunk sets m=1 except the last, which sets m=0.
 */
function encodeKitty(data: Uint8Array): string {
  const payload = toBase64(data);
  const CHUNK = 4096;
  const chunks: string[] = [];
  for (let offset = 0; offset < payload.length; offset += CHUNK) {
    chunks.push(payload.slice(offset, offset + CHUNK));
  }
  if (chunks.length === 0) chunks.push("");

  let out = "";
  chunks.forEach((chunk, index) => {
    const more = index < chunks.length - 1 ? 1 : 0;
    const control = index === 0 ? `a=T,f=100,m=${more}` : `m=${more}`;
    // ESC _ G <control> ; <chunk> ESC \
    out += `${ESC}_G${control};${chunk}${ESC}\\`;
  });
  return `${out}\n`;
}

/** Encode raw image bytes as an inline-image escape sequence for `protocol`. */
export function encodeInlineImage(
  data: Uint8Array,
  protocol: InlineImageProtocol,
): string {
  return protocol === "kitty" ? encodeKitty(data) : encodeIterm(data);
}
