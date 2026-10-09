/**
 * Parse a shell-like command input while preserving quoted argument boundaries.
 *
 * Shared by the server form and first-run onboarding so both connection paths
 * submit the same command and arguments. A plain whitespace split would corrupt
 * quoted paths, empty arguments, and escaped quotes.
 */
export function parseCommandInput(input: string): {
  command: string;
  args: string[];
} {
  const parts: string[] = [];
  let current = "";
  let inPart = false;
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];

    if (quote === "'") {
      if (char === "'") quote = null;
      else current += char;
      continue;
    }

    if (quote === '"') {
      if (char === "\\" && (input[i + 1] === '"' || input[i + 1] === "\\")) {
        current += input[i + 1];
        i += 1;
      } else if (char === '"') {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      inPart = true;
      continue;
    }

    // Outside quotes, preserve literal backslashes in Windows and UNC paths.
    if (/\s/.test(char)) {
      if (inPart) {
        parts.push(current);
        current = "";
        inPart = false;
      }
      continue;
    }

    current += char;
    inPart = true;
  }

  if (inPart) parts.push(current);

  return { command: parts[0] || "", args: parts.slice(1) };
}
