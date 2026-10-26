import { ExternalLink } from "lucide-react";

/** The people behind SpotiFlex and the projects it builds on, creator
 *  first. Avatars and profiles come from GitHub. */
export const PEOPLE = [
  { login: "Stormanzanii", name: "Arashii", role: "Creator of SpotiFlex" },
  {
    login: "iPixelGalaxy",
    name: "iPixelGalaxy",
    role: "Spotify+ and the Spicy Lyrics fork",
  },
  { login: "Spikerko", name: "Spikerko", role: "Creator of Spicy Lyrics" },
] as const;

/** Who SpotiFlex builds on, and under which licence. Shown in Settings and
 *  in the Lyrics settings About screen; README.md's Credits section lists the
 *  same people and projects, so keep the two in step. */
export const CREDITS = [
  {
    name: "Spotify+",
    by: "iPixelGalaxy",
    licence: "No licence declared",
    note: "The Add to playlist folders menu, reimplemented from its feature descriptions. No source is copied.",
    url: "https://github.com/iPixelGalaxy/spotify-plus",
  },
  {
    name: "Spicy Lyrics",
    by: "Spikerko · fork by iPixelGalaxy",
    licence: "AGPL-3.0",
    note: "Lyrics display, Space Gravity, word sync and the TTML tools reimplement its behaviour. Thanks to iPixelGalaxy for the fork SpotiFlex follows.",
    url: "https://github.com/iPixelGalaxy/spicy-lyrics",
  },
  {
    name: "librespot",
    by: "librespot contributors",
    licence: "MIT",
    note: "Spotify playback and Connect.",
    url: "https://github.com/librespot-org/librespot",
  },
  {
    name: "spr",
    by: "Fraktality",
    licence: "MIT",
    note: "The spring that animates lyrics.",
    url: "https://github.com/Fraktality/spr",
  },
  {
    name: "Kawarp",
    by: "Better Lyrics",
    licence: "MIT",
    note: "The warped artwork and Canvas ambience.",
    url: "https://github.com/better-lyrics/kawarp",
  },
] as const;

export function Credits({ onOpen }: { onOpen: (url: string) => void }) {
  return (
    <div className="credits">
      <h4 className="credits-heading">People</h4>
      <div className="credit-people">
        {PEOPLE.map((person) => (
          <button
            key={person.login}
            className="credit-person"
            title={`@${person.login} on GitHub`}
            onClick={() => onOpen(`https://github.com/${person.login}`)}
          >
            <img
              src={`https://github.com/${person.login}.png?size=96`}
              alt=""
              draggable={false}
              loading="lazy"
            />
            <span>
              <strong>{person.name}</strong>
              <small>{person.role}</small>
            </span>
          </button>
        ))}
      </div>
      <h4 className="credits-heading">Built on</h4>
      <div className="credit-projects">
        {CREDITS.map((credit) => (
          <button
            key={credit.name}
            className="credit-row"
            title={`Open ${credit.name} on GitHub`}
            onClick={() => onOpen(credit.url)}
          >
            <span className="credit-row-head">
              <strong>{credit.name}</strong>
              <span className="credit-licence">{credit.licence}</span>
              <ExternalLink size={14} aria-hidden="true" />
            </span>
            <small>{credit.by}</small>
            <span className="credit-note">{credit.note}</span>
          </button>
        ))}
      </div>
      <p className="credits-licence">
        SpotiFlex is free software under the GNU Affero General Public License
        v3.0. Spotify is a trademark of Spotify AB; SpotiFlex is not affiliated
        with Spotify.{" "}
        <button
          className="text-link"
          onClick={() => onOpen("https://github.com/Stormanzanii/SpotiFlex")}
        >
          Source code and licence
        </button>
      </p>
    </div>
  );
}
