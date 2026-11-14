import { App } from "@modelcontextprotocol/ext-apps";

const instance = crypto.randomUUID();
const button = document.querySelector<HTMLButtonElement>("button")!;
let count = 0;
button.dataset.instance = instance;
button.onclick = () => {
  button.textContent = `Count ${++count}`;
};

const app = new App(
  { name: "Counter", version: "1.0.0" },
  { tools: {}, availableDisplayModes: ["inline"] },
);
app.registerTool(
  "read_count",
  { description: "Read the live counter", annotations: { readOnlyHint: true } },
  async () => {
    const value = JSON.stringify({ instance, count });
    return { content: [{ type: "text", text: value }] };
  },
);
void app.connect().then(() => {
  button.disabled = false;
});
