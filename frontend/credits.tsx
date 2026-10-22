import { ExternalLink } from "lucide-react";

/** The people behind SpotiFlex and the projects it builds on, creator
 *  first. Avatars and profiles come from GitHub. */
export const PEOPLE = [
  { login: "Stormanzanii", name: "Arashii", role: "Creator of SpotiFlex" },
  { login: "iPixelGalaxy", name: "Pixel", role: "Spotify+ and the Spicy Lyrics fork" },
  { login: "Spikerko", name: "Spikerko", role: "Creator of Spicy Lyrics" },
] as const;

/** Who SpotiFlex builds on, and under which licence. Shown in Settings and
 *  in the Lyrics settings About tab. */
export const CREDITS = [
  {
    name: "Spotify+",
    by: "Pixel (iPixelGalaxy)",
    note: "Interface options and menus are reimplemented from its feature descriptions. No source is copied; the project declares no licence.",
    url: "https://github.com/iPixelGalaxy/spotify-plus",
  },
  {
    name: "Spicy Lyrics",
    by: "Spikerko, with Pixel's fork",
    note: "Lyrics display, Space Gravity, word sync and the TTML tools reimplement its behaviour. Thanks to Pixel for the fork SpotiFlex follows. AGPL-3.0.",
    url: "https://github.com/iPixelGalaxy/spicy-lyrics",
  },
  {
    name: "librespot",
    by: "librespot contributors",
    note: "Spotify playback and Connect. MIT.",
    url: "https://github.com/librespot-org/librespot",
  },
  {
    name: "spr",
    by: "Fraktality",
    note: "The spring that animates lyrics. MIT.",
    url: "https://github.com/Fraktality/spr",
  },
] as const;

export function Credits({ onOpen }: { onOpen: (url: string) => void }) {
  return (
    <div className="credits">
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
      {CREDITS.map((credit) => (
        <div className="credit-row" key={credit.name}>
          <div>
            <strong>{credit.name}</strong>
            <small>{credit.by}</small>
            <p>{credit.note}</p>
          </div>
          <button
            className="icon-button"
            aria-label={`Open ${credit.name}`}
            title={`Open ${credit.name}`}
            onClick={() => onOpen(credit.url)}
          >
            <ExternalLink size={16} />
          </button>
        </div>
      ))}
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
