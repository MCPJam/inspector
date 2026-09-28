import { createRoot } from "react-dom/client";

// Shared by the immediate loading screen and the asynchronous app bootstrap.
export const appRoot = createRoot(document.getElementById("root")!);
