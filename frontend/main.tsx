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
import "./fullscreen-lyrics.css";
import { CreatorProfiles } from "./creator-profile";
import { installOverlayScrollbars } from "./overlay-scrollbar";
import { LyricsPopout, POPOUT_VIEW } from "./lyrics-popout";
installOverlayScrollbars();
// The lyrics popout window loads the same page with its own view.
const popout = new URLSearchParams(location.search).get("view") === POPOUT_VIEW;
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {popout ? (
      <LyricsPopout />
    ) : (
      <CreatorProfiles>
        <App />
      </CreatorProfiles>
    )}
  </React.StrictMode>,
);
