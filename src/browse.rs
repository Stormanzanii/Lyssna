//! Spotify's Browse all categories and their pages, through the desktop
//! client's own browse queries.
use crate::home::{HomeSection, cards, images, text};
use crate::model::Artwork;
use anyhow::{Context, Result, ensure};
use librespot_core::Session;
use serde::Serialize;
use serde_json::{Value, json};

const BROWSE_ALL: &str = "dbd8b55e09a58afc52eab438bc228ba28fd72ac2f2148c6c26354980e4579001";
const BROWSE_PAGE: &str = "f5c4e6d668f5716464a231c1cc8b22c1cbf6ad68b09929fd7de813a30581298b";
const SECTIONS_PER_PAGE: usize = 10;

#[derive(Clone, Serialize)]
pub struct Category {
    pub id: String,
    pub title: String,
    pub color: String,
    pub images: Vec<Artwork>,
}

#[derive(Clone, Default, Serialize)]
pub struct BrowsePage {
    pub title: String,
    pub color: String,
    pub sections: Vec<HomeSection>,
    pub categories: Vec<Category>,
    pub next: Option<usize>,
}

fn page_id(uri: &str) -> Option<&str> {
    let id = uri.strip_prefix("spotify:page:")?;
    (!id.is_empty() && id.len() <= 64 && id.bytes().all(|c| c.is_ascii_alphanumeric()))
        .then_some(id)
}

fn hex_color(value: &Value) -> String {
    value["hex"]
        .as_str()
        .filter(|hex| {
            hex.len() == 7
                && hex.starts_with('#')
                && hex[1..].bytes().all(|c| c.is_ascii_hexdigit())
        })
        .unwrap_or("#535353")
        .to_ascii_lowercase()
}

fn category(item: &Value) -> Option<Category> {
    let id = page_id(item["uri"].as_str()?)?;
    let card = item.pointer("/content/data/data/cardRepresentation")?;
    let title = text(&card["title"]);
    if title.is_empty() {
        return None;
    }
    Some(Category {
        id: id.into(),
        title,
        color: hex_color(&card["backgroundColor"]),
        images: images(&json!({"coverArt": card["artwork"]})),
    })
}

fn categories(section: &Value) -> Vec<Category> {
    section
        .pointer("/sectionItems/items")
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(category).collect())
        .unwrap_or_default()
}

pub fn parse_all(value: &Value) -> Result<Vec<Category>> {
    let sections = value
        .pointer("/data/browseStart/sections/items")
        .and_then(Value::as_array)
        .context("Browse unavailable")?;
    let all: Vec<_> = sections.iter().flat_map(categories).collect();
    ensure!(!all.is_empty(), "Browse unavailable");
    Ok(all)
}

pub fn parse_page(value: &Value, offset: usize) -> Result<BrowsePage> {
    let browse = &value["data"]["browse"];
    ensure!(
        browse["__typename"] == "BrowseSectionContainer",
        "This category is unavailable"
    );
    let mut page = BrowsePage {
        title: text(&browse["header"]["title"]),
        color: hex_color(&browse["header"]["color"]),
        ..Default::default()
    };
    let sections = browse
        .pointer("/sections/items")
        .and_then(Value::as_array)
        .context("This category is unavailable")?;
    for section in sections {
        let grid = categories(section);
        if !grid.is_empty() {
            page.categories.extend(grid);
            continue;
        }
        let title = text(&section["data"]["title"]);
        let mut items = Vec::new();
        if let Some(children) = section
            .pointer("/sectionItems/items")
            .and_then(Value::as_array)
        {
            for child in children.iter().take(50) {
                cards(child, 0, &mut items);
            }
        }
        if !title.is_empty() && !items.is_empty() {
            page.sections.push(HomeSection {
                uri: text(&section["uri"]),
                title,
                subtitle: text(&section["data"]["subtitle"]),
                items,
                header_images: Vec::new(),
            });
        }
    }
    page.next = browse
        .pointer("/sections/pagingInfo/nextOffset")
        .and_then(Value::as_u64)
        .and_then(|next| usize::try_from(next).ok())
        .filter(|next| *next > offset && sections.len() == SECTIONS_PER_PAGE);
    Ok(page)
}

pub async fn all(session: &Session) -> Result<Vec<Category>> {
    let value = crate::catalogue::query(
        session,
        "browseAll",
        BROWSE_ALL,
        json!({
            "pagePagination": {"offset": 0, "limit": 10},
            "sectionPagination": {"offset": 0, "limit": 99},
            "browseEndUserIntegration": "INTEGRATION_DESKTOP"
        }),
    )
    .await?;
    parse_all(&value)
}

pub async fn page(session: &Session, id: &str, offset: usize) -> Result<BrowsePage> {
    let uri = format!("spotify:page:{id}");
    ensure!(page_id(&uri).is_some() && offset <= 500, "Unknown category");
    let value = crate::catalogue::query(
        session,
        "browsePage",
        BROWSE_PAGE,
        json!({
            "pagePagination": {"offset": offset, "limit": SECTIONS_PER_PAGE},
            "sectionPagination": {"offset": 0, "limit": 20},
            "uri": uri,
            "browseEndUserIntegration": "INTEGRATION_DESKTOP",
            "includeEpisodeContentRatingsV2": false
        }),
    )
    .await?;
    parse_page(&value, offset)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tile(uri: &str, title: &str, color: &str) -> Value {
        json!({
            "uri": uri,
            "content": {"__typename": "BrowseSectionContainerWrapper", "data": {
                "__typename": "BrowseSectionContainer",
                "data": {"cardRepresentation": {
                    "title": {"transformedLabel": title},
                    "backgroundColor": {"hex": color},
                    "artwork": {"sources": [{"url": "https://i.scdn.co/image/a", "width": 300, "height": 300}]}
                }}
            }}
        })
    }

    #[test]
    fn browse_all_keeps_category_pages_and_skips_client_features() {
        let value = json!({"data": {"browseStart": {"sections": {"items": [{
            "data": {"__typename": "BrowseGridSectionData", "title": {"transformedLabel": "Browse all"}},
            "sectionItems": {"items": [
                tile("spotify:page:0JQ5DAqbMKFSi39LMRT0Cy", "Music", "#DC148C"),
                {"uri": "spotify:concerts", "content": {"__typename": "BrowseXlinkResponseWrapper", "data": {
                    "__typename": "BrowseClientFeature", "title": {"transformedLabel": "Live Events"}}}},
                tile("spotify:page:bad/id", "Broken", "#000000"),
                tile("spotify:page:0JQ5DAqbMKFEC4WFtoNRpw", "Pop", "not a colour"),
            ]}
        }]}}}});
        let all = parse_all(&value).unwrap();
        let titles: Vec<_> = all.iter().map(|item| item.title.as_str()).collect();
        assert_eq!(titles, ["Music", "Pop"]);
        assert_eq!(all[0].color, "#dc148c");
        assert_eq!(all[1].color, "#535353");
        assert_eq!(all[0].images[0].url, "https://i.scdn.co/image/a");
    }

    #[test]
    fn a_category_page_has_shelves_subcategories_and_a_next_page() {
        let playlist = json!({"content": {"__typename": "PlaylistResponseWrapper", "data": {
            "__typename": "Playlist", "uri": "spotify:playlist:37i9dQZF1DWT2SPAYawYcO",
            "name": "New Music Friday", "description": "Brand new music",
            "images": {"items": [{"sources": [{"url": "https://i.scdn.co/image/b", "width": 300}]}]}
        }}});
        let mut sections = vec![
            json!({"uri": "spotify:section:a", "data": {"__typename": "BrowseGenericSectionData",
                "title": {"transformedLabel": "Playlists from our Editors"}},
                "sectionItems": {"items": [playlist]}}),
            json!({"uri": "spotify:section:b", "data": {"__typename": "BrowseGridSectionData",
                "title": {"transformedLabel": "Browse all"}},
                "sectionItems": {"items": [tile("spotify:page:0JQ5DAqbMKFEC4WFtoNRpw", "Pop", "#148a08")]}}),
            json!({"uri": "spotify:section:c", "data": {"__typename": "BrowseGenericSectionData",
                "title": {"transformedLabel": "Podcasts"}},
                "sectionItems": {"items": [{"content": {"__typename": "PodcastResponseWrapper",
                    "data": {"uri": "spotify:show:0123456789abcdefghijkl", "name": "A show"}}}]}}),
        ];
        sections.resize(SECTIONS_PER_PAGE, json!({}));
        let value = json!({"data": {"browse": {
            "__typename": "BrowseSectionContainer",
            "header": {"title": {"transformedLabel": "Music"}, "color": {"hex": "#DC148C"}},
            "sections": {"items": sections, "pagingInfo": {"nextOffset": 10}}
        }}});
        let page = parse_page(&value, 0).unwrap();
        assert_eq!(page.title, "Music");
        assert_eq!(page.color, "#dc148c");
        assert_eq!(page.sections.len(), 1);
        assert_eq!(
            page.sections[0].items[0].route,
            "playlist:37i9dQZF1DWT2SPAYawYcO"
        );
        assert_eq!(page.categories[0].title, "Pop");
        assert_eq!(page.next, Some(10));
    }

    #[test]
    fn the_last_category_page_has_no_next_page() {
        let value = json!({"data": {"browse": {
            "__typename": "BrowseSectionContainer",
            "header": {"title": {"transformedLabel": "Pop"}},
            "sections": {"items": [{}], "pagingInfo": {"nextOffset": 20}}
        }}});
        assert_eq!(parse_page(&value, 10).unwrap().next, None);
        assert!(
            parse_page(
                &json!({"data": {"browse": {"__typename": "GenericError"}}}),
                0
            )
            .is_err()
        );
    }

    #[test]
    #[ignore = "Reads Browse all and one category with the saved sign-in"]
    fn live_browse_reads_categories_and_a_page() {
        crate::native::with_live_session(async |session: &Session| {
            let all = all(session).await.unwrap();
            println!("{} categories", all.len());
            let music = &all[0];
            let first = page(session, &music.id, 0).await.unwrap();
            println!(
                "{}: {} shelves, {} subcategories, next {:?}",
                first.title,
                first.sections.len(),
                first.categories.len(),
                first.next
            );
            assert!(!first.sections.is_empty());
            if let Some(next) = first.next {
                let more = page(session, &music.id, next).await.unwrap();
                println!("next page: {} shelves", more.sections.len());
            }
        });
    }
}
