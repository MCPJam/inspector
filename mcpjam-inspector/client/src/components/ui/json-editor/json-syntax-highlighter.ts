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
        i++;
        break;

      case "}":
        tokens.push({ type: "punctuation", value: "}", start, end: i + 1 });
        contextStack.pop();
        expectingKey = false;
        i++;
        break;

      case "[":
        tokens.push({ type: "punctuation", value: "[", start, end: i + 1 });
        contextStack.push("array");
        expectingKey = false;
        i++;
        break;

      case "]":
        tokens.push({ type: "punctuation", value: "]", start, end: i + 1 });
        contextStack.pop();
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
        i++;
        break;

      case '"': {
        const value = readString();
        const isKey =
          expectingKey &&
          contextStack.length > 0 &&
          contextStack[contextStack.length - 1] === "object";
        tokens.push({
          type: isKey ? "key" : "string",
          value,
          start,
          end: i,
        });
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
        tokens.push({ type: "number", value, start, end: i });
        expectingKey = false;
        break;
      }

      case "t":
      case "f": {
        const value = readWord();
        if (value === "true") {
          tokens.push({ type: "boolean", value, start, end: i });
        } else if (value === "false") {
          tokens.push({ type: "boolean-false", value, start, end: i });
        }
        expectingKey = false;
        break;
      }

      case "n": {
        const value = readWord();
        if (value === "null") {
          tokens.push({ type: "null", value, start, end: i });
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
