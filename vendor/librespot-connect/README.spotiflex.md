# Local Connect adapter

Source: [School-User/librespot](https://github.com/School-User/librespot/tree/b199674d7c241eb82abce494f3f17a9d373b8d23/connect), revision `b199674d7c241eb82abce494f3f17a9d373b8d23`.

License: MIT, copyright 2015 Paul Lietar. The upstream license is included as `LICENSE`; see also the root `THIRD_PARTY_NOTICES.md`.

The manifest replaces workspace inheritance and relative dependency paths with explicit metadata. SpotiFlex accepts the audio player's transition from paused to playing, so direct local controls also update Spotify Connect's published playback state. Stale play-request IDs remain rejected. Other librespot crates remain pinned to the same revision.

SpotiFlex prepares one unheard DJ set in memory without activating playback. Fresh DJ starts and matching next-page requests consume it once; saved-session restores keep their own track and position. Preparing speech ahead of the selection avoids serial context and synthesis delays.

Playback-state uploads run concurrently with local transport commands. One upload remains in flight while later snapshots coalesce to the newest state; uploads remain ordered, and disconnect drains them before marking the device inactive.
