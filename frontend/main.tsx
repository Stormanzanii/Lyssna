import React from "react";
// Default lyrics typeface: Inter (SIL OFL), with optical sizes for display text.
import "@fontsource-variable/inter/opsz.css";
import { createRoot } from "react-dom/client";
import App from "./App";
import { CreatorProfiles } from "./creator-profile";
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <CreatorProfiles>
      <App />
    </CreatorProfiles>
  </React.StrictMode>,
);
