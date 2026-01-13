import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import WorldCupApp from "./ui-react";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Root element #root not found");
}

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <WorldCupApp />
  </React.StrictMode>
);










