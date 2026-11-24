import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@archival/ui";
import "@archival/glass";
import "@archival/viewers";
import "./styles/app.css";
import { App } from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
