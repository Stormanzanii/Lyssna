# Discord usernames in lyric credits (parked)

Status: removed on 2026-10-23, kept here so the work can be picked up again.

## Goal

Community lyrics from Spicy Lyrics credit their maker and uploader. SpotiFlex shows the name the lyrics API supplies, which is often a Discord display name ("Jane") instead of the account username ("@jane_doe"). The request was an option in Settings > Lyrics to show account usernames instead.

## What the sources allow

- **Spicy Lyrics developer API** (`GET https://api.spicylyrics.org/v1/lyrics/{track}`, used by SpotiFlex with its publishable key). `UploadAttribution.Uploader` and `.Maker` carry `id`, `username`, `url`, `avatar` and `hasProfileBanner`. The `username` field is documented as the username but, for some creators, holds the display name. The developer API has no profile or user endpoint.
- **Spicy Lyrics internal client API** (`POST https://api.spicylyrics.org/query`, operation `ttmlProfile`). This is what the Spicy Lyrics extension uses to resolve usernames. It answers independent clients with HTTP 418 and asks them to use the developer API instead, so SpotiFlex must not call it.
- **Spicy Lyrics website** (`https://spicylyrics.org/api/trpc/ttml.getTTMLProfile`, and the `/uid/{id}` profile redirect). Both return `captcha_required` / redirect to `/identity/captcha` unless the request carries the site's human-check pass cookie.

## The prototype that was removed

A Codex prototype added a `lyrics_discord_usernames` setting, a `creator_username` Tauri command and a cached frontend resolver (`contributor-name.tsx`). It called the website's `ttml.getTTMLProfile` with the `capt_pstk` cookie read from SpotiFlex's own webview after the user had passed the site's check while opening a creator profile. It also hard-coded two creator IDs to always keep their display names.

It was not shipped because it reuses a human-verification pass to automate background lookups the site deliberately gates, stops working whenever the pass expires, and the hard-coded IDs defeated the feature for those creators.

## Adding it back

Do this only through a sanctioned source:

1. Ask Spicy Lyrics to include the account username (separately from the display name) in the developer API's `UploadAttribution`, or to fix the `username` field to hold it.
2. Then add a setting such as `lyrics_discord_usernames` (default off) that picks that field when present and falls back to the supplied name. No extra network requests or cookies are needed.

The prototype's tests and code are not in the repository; they were discarded with this note.
