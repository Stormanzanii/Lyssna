import { memo, useMemo, type ReactNode } from "react";

/** Only catalogue pages supported by the in-app browser become links. */
export function spotifyTextRoute(href: string): string | undefined {
  const uri = /^spotify:(playlist|album|artist):([A-Za-z0-9]{22})$/.exec(
    href.trim(),
  );
  if (uri) return `${uri[1]}:${uri[2]}`;
  try {
    const url = new URL(href);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "open.spotify.com" ||
      url.username ||
      url.password ||
      url.port
    )
      return;
    const page =
      /^\/(?:intl-[a-z]{2}\/)?(playlist|album|artist)\/([A-Za-z0-9]{22})\/?$/.exec(
        url.pathname,
      );
    if (page) return `${page[1]}:${page[2]}`;
  } catch {
    /* Unrecognized links remain text. */
  }
}

const hidden = new Set([
  "SCRIPT",
  "STYLE",
  "TEMPLATE",
  "IFRAME",
  "OBJECT",
  "EMBED",
  "IMG",
  "SVG",
  "MATH",
  "LINK",
  "META",
  "BASE",
]);

/** Parse inert template content, then create only React text and known tags.
 * Provider markup is never mounted, so attributes and resource URLs cannot run. */
export const SpotifyText = memo(function SpotifyText({
  text,
  navigate,
}: {
  text: string;
  navigate: (route: string) => void;
}) {
  return useMemo(() => {
    if (!/[<&]/.test(text)) return text;
    const template = document.createElement("template");
    template.innerHTML = text;
    let key = 0;
    const render = (nodes: NodeListOf<ChildNode>): ReactNode[] =>
      Array.from(nodes, (node): ReactNode => {
        if (node.nodeType === Node.TEXT_NODE) return node.textContent;
        if (!(node instanceof HTMLElement) || hidden.has(node.tagName))
          return null;
        const id = key++;
        if (node.tagName === "BR") return <br key={id} />;
        if (node.tagName === "A") {
          const label = node.textContent || "";
          const route = spotifyTextRoute(node.getAttribute("href") || "");
          return route ? (
            <button
              key={id}
              type="button"
              role="link"
              className="spotify-description-link"
              onClick={() => navigate(route)}
              data-context-route={route}
              data-context-name={label}
            >
              {label}
            </button>
          ) : (
            label
          );
        }
        const children = render(node.childNodes);
        if (node.tagName === "B" || node.tagName === "STRONG")
          return <strong key={id}>{children}</strong>;
        if (node.tagName === "I" || node.tagName === "EM")
          return <em key={id}>{children}</em>;
        if (node.tagName === "P" || node.tagName === "DIV")
          return (
            <span key={id}>
              {children}
              <br />
            </span>
          );
        return <span key={id}>{children}</span>;
      });
    return render(template.content.childNodes);
  }, [text, navigate]);
});
