import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AnalyticsApp } from "./AnalyticsApp";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AnalyticsApp />
  </StrictMode>,
);
