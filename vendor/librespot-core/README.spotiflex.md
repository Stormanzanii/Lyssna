# Local core adapter

Source: [School-User/librespot](https://github.com/School-User/librespot/tree/b199674d7c241eb82abce494f3f17a9d373b8d23/core), revision `b199674d7c241eb82abce494f3f17a9d373b8d23`.

License: MIT, copyright 2015 Paul Lietar. The upstream license is included as `LICENSE`; see also the root `THIRD_PARTY_NOTICES.md`.

The manifest replaces workspace inheritance and relative dependency paths with explicit metadata. Other librespot crates remain pinned to the same revision.

The HTTP client pings idle HTTP/2 connections, expires idle pooled connections after 30 seconds and bounds TCP connects to 10 seconds. A router can drop an idle connection silently; without these, the first Spotify request after a long pause reused it and stalled Spotify Connect for about a minute before playback started.
