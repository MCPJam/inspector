type TokenType =
  | "string"
  | "number"
  | "boolean"
  | "boolean-false"
  | "null"
  | "key"
  | "punctuation";

interface Token {
  type: TokenType;
  value: string;
  start: number;
  end: number;
  path?: (string | number)[]; // e.g., ["user", "profile", 0]
  keyName?: string; // The key this value belongs to
}

/**
 * Formats a path array into a string with dot notation and bracket notation for arrays.
 * e.g., ["user", "profile", 0, "name"] -> "user.profile[0].name"
 */
export function formatPath(path: (string | number)[]): string {
  return path
    .map((p, i) => (typeof p === "number" ? `[${p}]` : i === 0 ? p : `.${p}`))
    .join("");
}

/**
 * Tokenizes a JSON string for syntax highlighting.
 * Returns an array of tokens with their types and positions.
 */
export function tokenizeJson(json: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  const skipWhitespace = () => {
    while (i < json.length && /\s/.test(json[i])) {
      i++;
    }
  };

  const readString = (): string => {
    const start = i;
    i++; // Skip opening quote
    while (i < json.length) {
      if (json[i] === "\\") {
        i += 2; // Skip escaped character
      } else if (json[i] === '"') {
        i++; // Skip closing quote
        break;
      } else {
        i++;
      }
    }
    return json.slice(start, i);
  };

  const readNumber = (): string => {
    const start = i;
    if (json[i] === "-") i++;
    while (i < json.length && /[0-9]/.test(json[i])) i++;
    if (json[i] === ".") {
      i++;
      while (i < json.length && /[0-9]/.test(json[i])) i++;
    }
    if (json[i] === "e" || json[i] === "E") {
      i++;
      if (json[i] === "+" || json[i] === "-") i++;
      while (i < json.length && /[0-9]/.test(json[i])) i++;
    }
    return json.slice(start, i);
  };

  const readWord = (): string => {
    const start = i;
    while (i < json.length && /[a-z]/.test(json[i])) i++;
    return json.slice(start, i);
  };

  // Stack to track context (for determining if a string is a key)
  const contextStack: ("object" | "array")[] = [];
  let expectingKey = false;

  // Path tracking
  const pathStack: (string | number)[] = [];
  let currentKey: string | null = null;

  while (i < json.length) {
    skipWhitespace();
    if (i >= json.length) break;

    const char = json[i];
    const start = i;

    switch (char) {
      case "{":
        tokens.push({ type: "punctuation", value: "{", start, end: i + 1 });
        contextStack.push("object");
        expectingKey = true;
        // If we have a current key, it's now part of the path
        if (currentKey !== null) {
          pathStack.push(currentKey);
          currentKey = null;
        }
        i++;
        break;

      case "}":
        tokens.push({ type: "punctuation", value: "}", start, end: i + 1 });
        contextStack.pop();
        // Pop the object key from path if we're closing an object
        if (
          pathStack.length > 0 &&
          typeof pathStack[pathStack.length - 1] === "string"
        ) {
          pathStack.pop();
        }
        expectingKey = false;
        i++;
        break;

      case "[":
        tokens.push({ type: "punctuation", value: "[", start, end: i + 1 });
        contextStack.push("array");
        // If we have a current key, it's now part of the path
        if (currentKey !== null) {
          pathStack.push(currentKey);
          currentKey = null;
        }
        // Push array index 0
        pathStack.push(0);
        expectingKey = false;
        i++;
        break;

      case "]":
        tokens.push({ type: "punctuation", value: "]", start, end: i + 1 });
        contextStack.pop();
        // Pop the array index
        if (
          pathStack.length > 0 &&
          typeof pathStack[pathStack.length - 1] === "number"
        ) {
          pathStack.pop();
        }
        // Pop the key that held the array if any
        if (
          pathStack.length > 0 &&
          typeof pathStack[pathStack.length - 1] === "string"
        ) {
          pathStack.pop();
        }
        expectingKey = false;
        i++;
        break;

      case ":":
        tokens.push({ type: "punctuation", value: ":", start, end: i + 1 });
        expectingKey = false;
        i++;
        break;

      case ",":
        tokens.push({ type: "punctuation", value: ",", start, end: i + 1 });
        // After comma in object, expect key
        expectingKey =
          contextStack.length > 0 &&
          contextStack[contextStack.length - 1] === "object";
        // In array context, increment the index
        if (
          contextStack.length > 0 &&
          contextStack[contextStack.length - 1] === "array" &&
          pathStack.length > 0 &&
          typeof pathStack[pathStack.length - 1] === "number"
        ) {
          pathStack[pathStack.length - 1] =
            (pathStack[pathStack.length - 1] as number) + 1;
        }
        i++;
        break;

      case '"': {
        const value = readString();
        const isKey =
          expectingKey &&
          contextStack.length > 0 &&
          contextStack[contextStack.length - 1] === "object";

        if (isKey) {
          // Parse the key name (remove quotes)
          let keyName: string;
          try {
            keyName = JSON.parse(value);
          } catch {
            keyName = value.slice(1, -1);
          }
          // Store the key for the upcoming value
          currentKey = keyName;
          // For key tokens, the path is the current path + this key
          tokens.push({
            type: "key",
            value,
            start,
            end: i,
            path: [...pathStack, keyName],
            keyName,
          });
        } else {
          // String value - store current path and key info
          const valuePath =
            currentKey !== null ? [...pathStack, currentKey] : [...pathStack];
          tokens.push({
            type: "string",
            value,
            start,
            end: i,
            path: valuePath,
            keyName: currentKey ?? undefined,
          });
          currentKey = null;
        }
        break;
      }

      case "-":
      case "0":
      case "1":
      case "2":
      case "3":
      case "4":
      case "5":
      case "6":
      case "7":
      case "8":
      case "9": {
        const value = readNumber();
        const valuePath =
          currentKey !== null ? [...pathStack, currentKey] : [...pathStack];
        tokens.push({
          type: "number",
          value,
          start,
          end: i,
          path: valuePath,
          keyName: currentKey ?? undefined,
        });
        currentKey = null;
        expectingKey = false;
        break;
      }

      case "t":
      case "f": {
        const value = readWord();
        const valuePath =
          currentKey !== null ? [...pathStack, currentKey] : [...pathStack];
        if (value === "true") {
          tokens.push({
            type: "boolean",
            value,
            start,
            end: i,
            path: valuePath,
            keyName: currentKey ?? undefined,
          });
        } else if (value === "false") {
          tokens.push({
            type: "boolean-false",
            value,
            start,
            end: i,
            path: valuePath,
            keyName: currentKey ?? undefined,
          });
        }
        currentKey = null;
        expectingKey = false;
        break;
      }

      case "n": {
        const value = readWord();
        if (value === "null") {
          const valuePath =
            currentKey !== null ? [...pathStack, currentKey] : [...pathStack];
          tokens.push({
            type: "null",
            value,
            start,
            end: i,
            path: valuePath,
            keyName: currentKey ?? undefined,
          });
          currentKey = null;
        }
        expectingKey = false;
        break;
      }

      default:
        // Skip unknown characters
        i++;
    }
  }

  return tokens;
}

/**
 * Converts JSON string to highlighted HTML.
 * Returns HTML with span elements containing appropriate classes.
 */
export function highlightJson(json: string): string {
  const tokens = tokenizeJson(json);
  let result = "";
  let lastIndex = 0;

  for (const token of tokens) {
    // Add any characters between tokens (whitespace)
    if (token.start > lastIndex) {
      result += escapeHtml(json.slice(lastIndex, token.start));
    }

    // Add the token with its class
    const className = `json-${token.type}`;
    result += `<span class="${className}">${escapeHtml(token.value)}</span>`;
    lastIndex = token.end;
  }

  // Add any remaining characters
  if (lastIndex < json.length) {
    result += escapeHtml(json.slice(lastIndex));
  }

  return result;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
