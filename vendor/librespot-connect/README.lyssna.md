# Local Connect adapter

Source: [School-User/librespot](https://github.com/School-User/librespot/tree/b199674d7c241eb82abce494f3f17a9d373b8d23/connect), revision `b199674d7c241eb82abce494f3f17a9d373b8d23`.

License: MIT, copyright 2015 Paul Lietar. The upstream license is included as `LICENSE`; see also the root `THIRD_PARTY_NOTICES.md`.

The manifest replaces workspace inheritance and relative dependency paths with explicit metadata. Lyssna accepts the audio player's transition from paused to playing, so direct local controls also update Spotify Connect's published playback state. Stale play-request IDs remain rejected. Other librespot crates remain pinned to the same revision.

Lyssna prepares one unheard DJ set in memory without activating playback. Fresh DJ starts and matching next-page requests consume it once; saved-session restores keep their own track and position. Preparing speech ahead of the selection avoids serial context and synthesis delays.

Playback-state uploads run concurrently with local transport commands. One upload remains in flight while later snapshots coalesce to the newest state; uploads remain ordered, and disconnect drains them before marking the device inactive.

The next queued track preloads when the current decoder becomes ready. A stale track-change event cannot start this prefetch. Narration metadata still reaches the player before its preload command.

Queue snapshots also emit after the current selection resolves, before its player load. Local queue views therefore receive the updated upcoming tracks instead of the empty snapshot from initial context creation.

Lyssna also exposes the account-local Connect cluster snapshot already received by device discovery. This supplies remote playback state without public Web API polling. No new subscription, credentials or network listener is added. Remote command payloads are independently constructed against librespot's MIT-licensed dealer protocol definitions; no other project source is copied.

DJ speaks each introduction once: going back to a song it introduced plays the song alone. The same song introduced anew in a later set still speaks.

Skipping forward or back to another song starts it playing, even when paused, as Spotify's clients do. A song that ends or fails still moves on in the current play state, and going back to the start of the same song keeps it paused.
