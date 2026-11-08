import { Fragment, useEffect, useState, type CSSProperties } from "react";
import { LoaderCircle } from "lucide-react";
import { rpc } from "./bridge";
import { artworkFor } from "./artwork";
import { Shelf } from "./HomePage";
import type { BrowseCategory, BrowseCategoryPage, HomeItem } from "./types";
import "./BrowsePage.css";

// Spotify changes Browse all rarely; one read per session is enough.
let categoriesCache: BrowseCategory[] | undefined;

function CategoryTile({
  category,
  open,
}: {
  category: BrowseCategory;
  open: (id: string) => void;
}) {
  const art = artworkFor(category.images, 200);
  return (
    <button
      type="button"
      className="browse-tile"
      style={{ "--tile": category.color } as CSSProperties}
      onClick={() => open(category.id)}
    >
      <span>
        {category.title.split("/").map((part, index) => (
          <Fragment key={index}>
            {index > 0 && (
              <>
                <wbr />/
              </>
            )}
            {part}
          </Fragment>
        ))}
      </span>
      {art && <img src={art} alt="" loading="lazy" draggable={false} />}
    </button>
  );
}

function CategoryGrid({
  categories,
  open,
}: {
  categories: BrowseCategory[];
  open: (id: string) => void;
}) {
  return (
    <div className="browse-grid">
      {categories.map((category) => (
        <CategoryTile key={category.id} category={category} open={open} />
      ))}
    </div>
  );
}

function BrowseAll({ open }: { open: (id: string) => void }) {
  const [categories, setCategories] = useState(categoriesCache);
  const [error, setError] = useState("");
  useEffect(() => {
    if (categoriesCache) return;
    let live = true;
    rpc<BrowseCategory[]>("browse_categories")
      .then((all) => {
        categoriesCache = all;
        if (live) setCategories(all);
      })
      .catch((reason) => live && setError(String(reason)));
    return () => {
      live = false;
    };
  }, []);
  return (
    <div className="browse-page">
      <h1>Browse all</h1>
      {categories ? (
        <CategoryGrid categories={categories} open={open} />
      ) : error ? (
        <p className="browse-message">{error}</p>
      ) : (
        <LoaderCircle className="spin browse-loading" size={26} />
      )}
    </div>
  );
}

function CategoryPage({
  id,
  open,
  navigate,
  play,
  ready,
}: {
  id: string;
  open: (id: string) => void;
  navigate: (route: string, item?: HomeItem) => void;
  play: (item: HomeItem) => void;
  ready: boolean;
}) {
  const [page, setPage] = useState<BrowseCategoryPage>();
  const [error, setError] = useState("");
  const [more, setMore] = useState(false);
  useEffect(() => {
    let live = true;
    rpc<BrowseCategoryPage>("browse_page", { id, offset: 0 })
      .then((first) => live && setPage(first))
      .catch((reason) => live && setError(String(reason)));
    return () => {
      live = false;
    };
  }, [id]);
  const loadMore = () => {
    if (!page?.next || more) return;
    setMore(true);
    rpc<BrowseCategoryPage>("browse_page", { id, offset: page.next })
      .then((next) =>
        setPage((known) =>
          known
            ? {
                ...known,
                sections: [...known.sections, ...next.sections],
                categories: [...known.categories, ...next.categories],
                next: next.next,
              }
            : known,
        ),
      )
      .catch(() => setPage((known) => known && { ...known, next: null }))
      .finally(() => setMore(false));
  };
  if (error) return <p className="browse-message">{error}</p>;
  if (!page) return <LoaderCircle className="spin browse-loading" size={26} />;
  return (
    <div className="browse-category">
      <header
        className="browse-category-hero"
        style={{ "--tile": page.color } as CSSProperties}
      >
        <h1>{page.title}</h1>
      </header>
      <div className="browse-page">
        {page.sections.map((section, index) => (
          <Shelf
            key={`${section.uri}-${index}`}
            section={section}
            navigate={navigate}
            play={play}
            ready={ready}
          />
        ))}
        {page.categories.length > 0 && (
          <section className="browse-subcategories">
            <h2>Browse all</h2>
            <CategoryGrid categories={page.categories} open={open} />
          </section>
        )}
        {!page.sections.length && !page.categories.length && (
          <p className="browse-message">
            Nothing here plays in Lyssna yet. Podcasts and audiobooks aren't
            supported.
          </p>
        )}
        {page.next != null && (
          <button
            type="button"
            className="browse-more"
            disabled={more}
            onClick={loadMore}
          >
            {more ? "Loading…" : "Show more"}
          </button>
        )}
      </div>
    </div>
  );
}

export function BrowsePage({
  route,
  navigate,
  play,
  ready,
}: {
  route: string;
  navigate: (route: string, item?: HomeItem) => void;
  play: (item: HomeItem) => void;
  ready: boolean;
}) {
  const open = (id: string) => navigate(`browse:${id}`);
  const id = route.startsWith("browse:") ? route.slice(7) : "";
  return id ? (
    <CategoryPage
      key={id}
      id={id}
      open={open}
      navigate={navigate}
      play={play}
      ready={ready}
    />
  ) : (
    <BrowseAll open={open} />
  );
}
