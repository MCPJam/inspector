/**
 * Rewrites a `text/event-stream` body one whole event at a time. An event can
 * arrive split across chunks, and so can the CRLF that ends a line, so text is
 * buffered until a blank line ends the event. An event `rewrite` leaves alone
 * goes out as it came in, as soon as it is complete.
 */

const LINE_BREAK = /\r\n|\r|\n/;

/** Splits decoded text into whole events, each kept raw through its blank line. */
class SseEventSplitter {
  private buffer = "";
  /** Where the line being read starts. Every line before it is non-blank. */
  private lineStart = 0;
  private readonly lineEnd = /\r\n|\r|\n/g;

  push(text: string, final = false): string[] {
    this.buffer += text;
    const events: string[] = [];
    this.lineEnd.lastIndex = this.lineStart;
    for (
      let match = this.lineEnd.exec(this.buffer);
      match;
      match = this.lineEnd.exec(this.buffer)
    ) {
      // A CR that ends the text may be half of a CRLF whose LF hasn't arrived.
      if (
        match[0] === "\r" &&
        match.index === this.buffer.length - 1 &&
        !final
      ) {
        break;
      }
      const end = match.index + match[0].length;
      if (match.index === this.lineStart) {
        events.push(this.buffer.slice(0, end));
        this.buffer = this.buffer.slice(end);
        this.lineStart = 0;
        this.lineEnd.lastIndex = 0;
      } else {
        this.lineStart = end;
      }
    }
    return events;
  }

  /** The text after the last whole event: one the stream ended before finishing. */
  rest(): string {
    return this.buffer;
  }
}

function isDataLine(line: string): boolean {
  return line === "data" || line.startsWith("data:");
}

/** The event's data: its `data` lines joined with newlines. */
function eventData(event: string): string | undefined {
  const lines = event.split(LINE_BREAK).filter(isDataLine);
  if (lines.length === 0) return undefined;
  return lines
    .map((line) => line.slice(line.startsWith("data: ") ? 6 : 5))
    .join("\n");
}

/** The event with its data replaced, keeping its other fields in order. */
function withData(event: string, data: string): string {
  const lines: string[] = [];
  let placed = false;
  for (const line of event.split(LINE_BREAK)) {
    if (line === "") continue;
    if (!isDataLine(line)) lines.push(line);
    else if (!placed) {
      lines.push(`data: ${data}`);
      placed = true;
    }
  }
  return `${lines.join("\n")}\n\n`;
}

/**
 * Pipes `body` through `rewrite`, which gets each event's data and returns
 * the new data, or `undefined` to send the event unchanged.
 */
export function rewriteSseEvents(
  body: ReadableStream<Uint8Array>,
  rewrite: (data: string) => Promise<string | undefined>
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const splitter = new SseEventSplitter();
  const send = async (
    events: string[],
    controller: TransformStreamDefaultController<Uint8Array>
  ) => {
    for (const event of events) {
      const data = eventData(event);
      const next = data === undefined ? undefined : await rewrite(data);
      controller.enqueue(
        encoder.encode(next === undefined ? event : withData(event, next))
      );
    }
  };
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform: (chunk, controller) =>
        send(
          splitter.push(decoder.decode(chunk, { stream: true })),
          controller
        ),
      flush: async (controller) => {
        await send(splitter.push(decoder.decode(), true), controller);
        const rest = splitter.rest();
        if (rest) controller.enqueue(encoder.encode(rest));
      },
    })
  );
}
