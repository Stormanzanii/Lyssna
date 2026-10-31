import "./storage-migration";
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
import { CINEMA_VIEW, CinemaLyrics } from "./cinema";
installOverlayScrollbars();
// The lyrics popout and Cinema windows load the same page with their own
// view.
const view = new URLSearchParams(location.search).get("view");
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {view === POPOUT_VIEW ? (
      <LyricsPopout />
    ) : view === CINEMA_VIEW ? (
      <CinemaLyrics />
    ) : (
      <CreatorProfiles>
        <App />
      </CreatorProfiles>
    )}
  </React.StrictMode>,
);
