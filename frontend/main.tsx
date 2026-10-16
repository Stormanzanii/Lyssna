import React from "react";
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
