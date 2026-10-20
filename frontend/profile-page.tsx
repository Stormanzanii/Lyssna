import { ExternalLink, User } from "lucide-react";
import type { Playlist, Profile } from "./types";
import { Cover, imageOf } from "./components";

/** The signed-in user's profile: their own playlists plus a link to Spotify. */
export function ProfilePage({
  profile,
  playlists,
  onPlaylist,
  onRecents,
  onOpen,
}: {
  profile?: Profile;
  playlists: Playlist[];
  onPlaylist: (playlist: Playlist) => void;
  onRecents: () => void;
  onOpen: (url: string) => void;
}) {
  if (!profile) return null;
  const name = profile.display_name || profile.id;
  const owned = playlists.filter(
    (playlist) => playlist.owner.id === profile.id,
  );
  const image = imageOf(profile.images);
  return (
    <div className="browse-scroll profile-page">
      <div className="entity-header">
        {image && (
          <div
            className="entity-tint"
            style={{ backgroundImage: `url(${JSON.stringify(image)})` }}
          />
        )}
        <section className="page-hero profile-hero">
          <div className="hero-cover profile-avatar">
            {image ? (
              <img src={image} alt="" draggable={false} />
            ) : (
              <User size={72} />
            )}
          </div>
          <div className="hero-copy">
            <span className="eyebrow">Profile</span>
            <h1>{name}</h1>
            <p className="hero-meta">
              {owned.length} playlist{owned.length === 1 ? "" : "s"}
            </p>
          </div>
        </section>
        <div className="browse-actions">
          <button className="pill outline" onClick={onRecents}>
            Recently played
          </button>
          <button
            className="pill outline"
            onClick={() =>
              onOpen(
                `https://open.spotify.com/user/${encodeURIComponent(profile.id)}`,
              )
            }
          >
            Open in Spotify
            <ExternalLink size={14} />
          </button>
        </div>
      </div>
      <div className="browse-section-title">
        <h2>Playlists</h2>
      </div>
      {owned.length ? (
        <div className="album-grid">
          {owned.map((playlist) => (
            <button
              key={playlist.id}
              className="album-tile"
              data-context-route={`playlist:${playlist.id}`}
              data-context-name={playlist.name}
              onClick={() => onPlaylist(playlist)}
            >
              <Cover images={playlist.images} />
              <strong>{playlist.name}</strong>
              <small>
                {playlist.collaborative ? "Collaborative" : "Playlist"}
              </small>
            </button>
          ))}
        </div>
      ) : (
        <p className="profile-empty">Playlists you create appear here.</p>
      )}
    </div>
  );
}
