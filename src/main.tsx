import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { hydrate } from "./state/store";
import "./styles.css";

// Load saved chats from data/ first, so the app never flashes empty.
void hydrate().finally(() =>
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  ),
);
