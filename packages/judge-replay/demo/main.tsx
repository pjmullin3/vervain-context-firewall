import React from "react";
import { createRoot } from "react-dom/client";
import "../src/styles/tokens.css";
import "../src/styles/replay.css";
import { DemoApp } from "./App.js";

const container = document.getElementById("root");
if (!container) {
  throw new Error("Missing #root mount element.");
}

createRoot(container).render(
  <React.StrictMode>
    <DemoApp />
  </React.StrictMode>
);
