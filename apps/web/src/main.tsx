// Imported first, before anything else: captures a `?cfxPassword=` URL param into the
// password store as the very first thing the app does (see pltdPassword.ts).
import "./state/pltdPassword";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "uplot/dist/uPlot.min.css";
import "./theme.css";
import "./app.css";
import { App } from "./App";
import { BrowserWarningModal } from "./components/BrowserWarningModal";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
    <BrowserWarningModal />
  </StrictMode>,
);
