import { App } from "spike-app";
import { z } from "zod";

async function start() {
  const settings = JSON.parse(document.getElementById("settings").textContent);
  const legacy = settings.source === "legacy";
  const wrapper = settings.source.startsWith("v3");
  const app = new App(
    { name: "WebMCP spike", version: "1.0.0" },
    legacy || settings.source === "v3-tools"
      ? { tools: { listChanged: true } }
      : {},
    { autoResize: false },
  );
  let moves = 0;
  document.body.dataset.moves = "0";

  async function execute(input, extra) {
    if (input.kind === "wait") {
      document.body.dataset.waiting = "true";
      return new Promise((resolve, reject) => {
        extra.signal.addEventListener(
          "abort",
          () => {
            document.body.dataset.cancelled = "true";
            reject(new Error("Cancelled by host"));
          },
          { once: true },
        );
      });
    }
    if (input.kind === "large") return { text: "é".repeat(200_000) };
    if (input.kind === "cycle") {
      const value = {};
      value.self = value;
      return value;
    }
    if (typeof input.delay === "number")
      await new Promise((resolve) => setTimeout(resolve, input.delay));
    moves++;
    document.body.dataset.moves = String(moves);
    return { board: settings.id, move: input.move || "e4", moves };
  }

  if (legacy || wrapper) {
    app.registerTool(
      "make_move",
      {
        description: "Move a chess piece",
        inputSchema: z.object({
          kind: z.string().optional(),
          move: z.string().optional(),
          delay: z.number().optional(),
        }),
      },
      async (input, extra) => {
        const value = await execute(input, extra);
        return {
          content: [{ type: "text", text: JSON.stringify(value) }],
          structuredContent: value,
        };
      },
    );
  } else {
    // The spike's registration API is supplied by the exact injected runtime.
    const context = Reflect.get(document, "modelContext");
    if (context) {
      try {
        const controller = new AbortController();
        Reflect.set(window, "initialTool", controller);
        await context.registerTool(
          {
            name: "make_move",
            description: "Move a chess piece",
            inputSchema: { type: "object" },
            execute,
          },
          { signal: controller.signal },
        );
      } catch (error) {
        document.body.dataset.registrationError = String(error);
      }
    }
  }
  await app.connect();
}
void start();
