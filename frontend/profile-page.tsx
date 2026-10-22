import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Copy, ExternalLink, MoreHorizontal, User } from "lucide-react";
import type { HomeItem, Profile, UserProfilePage } from "./types";
import { imageOf } from "./components";
import { Shelf } from "./HomePage";
import { useArtworkColor } from "./artwork-color";
import { rpc } from "./bridge";

/** Pages already shown, so returning to a profile is instant. */
const pages = new Map<string, UserProfilePage>();

const plural = (count: number, one: string) =>
  `${count.toLocaleString()} ${one}${count === 1 ? "" : "s"}`;

/** A Spotify profile laid out like the desktop client: tinted header with
 *  counts, then rows of top artists, playlists, artists and people. */
export function ProfilePage({
  user,
  hint,
  ready,
  onNavigate,
  onPlay,
  onUser,
  onOpen,
  onNotice,
}: {
  user: string;
  /** Known name and picture, shown while the page loads. */
  hint?: Profile;
  ready: boolean;
  onNavigate: (route: string, item?: HomeItem) => void;
  onPlay: (item: HomeItem) => void;
  onUser: (id: string, hint: Profile) => void;
  onOpen: (url: string) => void;
  onNotice: (message: string, error?: boolean) => void;
}) {
  const [page, setPage] = useState(() => pages.get(user));
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [menu, setMenu] = useState(false);
  const [following, setFollowing] = useState(false);
  const [heroGone, setHeroGone] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const hero = useRef<HTMLElement>(null);
  useEffect(() => {
    setPage(pages.get(user));
    setFailed(false);
    setMenu(false);
    setFollowing(false);
    root.current?.scrollTo({ top: 0 });
    let live = true;
    rpc<UserProfilePage>("user_profile", { user })
      .then((result) => {
        if (!live || result.id !== user) return;
        pages.set(user, result);
        setPage(result);
      })
      .catch(() => live && setFailed(true));
    // A newer profile or a retry supersedes this request.
    return () => {
      live = false;
    };
  }, [user, attempt]);
  // Show the compact name bar once the header scrolls under it.
  useEffect(() => {
    const element = hero.current,
      scroller = root.current;
    if (!element || !scroller) return;
    const observer = new IntersectionObserver(
      ([entry]) => setHeroGone(!entry.isIntersecting),
      { root: scroller, rootMargin: "-64px 0px 0px 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!menu) return;
    const close = (event: PointerEvent) => {
      if (!(event.target as Element | null)?.closest(".profile-more"))
        setMenu(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [menu]);
  const shown = page?.id === user ? page : undefined;
  const name = shown?.name || hint?.display_name || "";
  const image = imageOf(shown?.images.length ? shown.images : hint?.images);
  const color = useArtworkColor(image) ?? "rgb(83 83 83)";
  const link = `https://open.spotify.com/user/${encodeURIComponent(user)}`;
  const jump = (title: string) =>
    root.current
      ?.querySelector(`section[aria-label="${title}"]`)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  const navigate = (route: string, item?: HomeItem) => {
    if (route.startsWith("user:"))
      onUser(route.slice(5), {
        id: route.slice(5),
        display_name: item?.name,
        images: item?.images,
      });
    else onNavigate(route, item);
  };
  return (
    <div
      className="browse-scroll profile-page"
      ref={root}
      style={{ "--hero": color } as CSSProperties}
    >
      <div
        className={`artist-sticky profile-sticky ${heroGone ? "shown" : ""}`}
        aria-hidden={!heroGone}
      >
        <strong>{name}</strong>
      </div>
      <div className="entity-header">
        <section className="page-hero profile-hero" ref={hero}>
          <div className="hero-cover profile-avatar">
            {image ? (
              <img src={image} alt="" draggable={false} />
            ) : (
              <User size={72} />
            )}
          </div>
          <div className="hero-copy">
            <span className="eyebrow">Profile</span>
            <h1 className={name.length > 18 ? "long-title" : ""}>{name}</h1>
            {shown && (
              <p className="hero-meta profile-counts">
                <span>{plural(shown.public_playlists, "Public Playlist")}</span>
                <button onClick={() => jump("Followers")}>
                  {plural(shown.followers, "Follower")}
                </button>
                <button onClick={() => jump("Following")}>
                  {shown.following.toLocaleString()} Following
                </button>
              </p>
            )}
          </div>
        </section>
        <div className="browse-actions profile-actions">
          {shown &&
            !shown.is_current_user &&
            shown.is_following != null &&
            (shown.allow_follows || shown.is_following) && (
              <button
                className={`pill outline profile-follow ${shown.is_following ? "following" : ""}`}
                disabled={following}
                aria-pressed={shown.is_following}
                onClick={() => {
                  const follow = !shown.is_following;
                  setFollowing(true);
                  rpc<boolean>("follow_user", { user, follow })
                    .then((now) => {
                      const next = {
                        ...shown,
                        is_following: now,
                        followers: Math.max(
                          0,
                          shown.followers + (now === !!shown.is_following ? 0 : now ? 1 : -1),
                        ),
                      };
                      pages.set(user, next);
                      setPage((current) => (current?.id === user ? next : current));
                    })
                    .catch((error) => onNotice(String(error), true))
                    .finally(() => setFollowing(false));
                }}
              >
                {shown.is_following ? "Following" : "Follow"}
              </button>
            )}
          <div className="profile-more">
            <button
              className={`icon-button ${menu ? "active" : ""}`}
              title="More options"
              aria-label={`More options for ${name || "profile"}`}
              aria-expanded={menu}
              onClick={() => setMenu(!menu)}
            >
              <MoreHorizontal size={24} />
            </button>
            {menu && (
              <div className="profile-menu" role="menu">
                <button
                  role="menuitem"
                  onClick={() => {
                    setMenu(false);
                    void navigator.clipboard
                      .writeText(link)
                      .then(() => onNotice("Profile link copied."))
                      .catch(() => onNotice("Could not copy the link.", true));
                  }}
                >
                  <span>
                    <Copy size={16} />
                    Copy link to profile
                  </span>
                </button>
                <button
                  role="menuitem"
                  onClick={() => {
                    setMenu(false);
                    onOpen(link);
                  }}
                >
                  <span>
                    <ExternalLink size={16} />
                    Open in Spotify
                  </span>
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
      {shown ? (
        shown.sections.length ? (
          <div className="profile-sections">
            {shown.sections.map((section) => (
              <Shelf
                key={section.uri}
                section={section}
                navigate={navigate}
                play={onPlay}
                ready={ready}
                noteBelow
              />
            ))}
          </div>
        ) : (
          <p className="profile-empty">
            {shown.is_current_user
              ? "Public playlists, artists and people you follow appear here."
              : "This profile has nothing public yet."}
          </p>
        )
      ) : failed ? (
        <div className="profile-empty">
          <p>Spotify did not send this profile.</p>
          <button className="pill outline" onClick={() => setAttempt(attempt + 1)}>
            Try again
          </button>
        </div>
      ) : (
        <div className="profile-sections profile-loading" aria-busy="true">
          {[0, 1].map((row) => (
            <div className="profile-skeleton-row" key={row}>
              {Array.from({ length: 6 }, (_, index) => (
                <span key={index} />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
