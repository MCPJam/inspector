import { Hono } from "hono";
import { handleManagedChatTurn } from "../../services/chat-turn/managed-turn.js";
export { handleManagedChatTurn };
const chatV2 = new Hono();
chatV2.post("/", (c) => handleManagedChatTurn(c, "web"));
export default chatV2;
