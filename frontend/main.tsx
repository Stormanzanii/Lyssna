import React from "react";
// Default lyrics typeface: Inter (SIL OFL), with optical sizes for display text.
import "@fontsource-variable/inter/opsz.css";
// Interface typeface: Metropolis (public domain), Latin weights in use.
import "@fontsource/metropolis/latin-400.css";
import "@fontsource/metropolis/latin-500.css";
import "@fontsource/metropolis/latin-600.css";
import "@fontsource/metropolis/latin-700.css";
import "@fontsource/metropolis/latin-800.css";
import "@fontsource/metropolis/latin-900.css";
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
