import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { McpConnectionsProvider } from "./hooks/McpConnectionsProvider";
import { Toaster } from "./components/ui/sonner";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <McpConnectionsProvider>
      <App />
      <Toaster />
    </McpConnectionsProvider>
  </StrictMode>,
);
