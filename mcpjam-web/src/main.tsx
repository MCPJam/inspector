import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { McpConnectionsProvider } from "./hooks/McpConnectionsProvider";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <McpConnectionsProvider>
      <App />
    </McpConnectionsProvider>
  </StrictMode>,
);
