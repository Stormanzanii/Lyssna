# Local playback adapter

Source: [School-User/librespot](https://github.com/School-User/librespot/tree/b199674d7c241eb82abce494f3f17a9d373b8d23/playback), revision `b199674d7c241eb82abce494f3f17a9d373b8d23`. This is the experimental DJ implementation from upstream pull request 1797.

License: MIT, copyright 2015 Paul Lietar. The upstream license is included as `LICENSE`; distribution notices also appear in the root `THIRD_PARTY_NOTICES.md`.

Playback and Connect are vendored. Other librespot crates remain pinned to the same revision. The manifest replaces workspace inheritance and relative dependency paths with explicit package metadata and dependencies resolved by the application's patches.

SpotiFlex changes tag decoded narration packets. Its audio sink can identify speech when samples reach playback, without treating buffering or paused music as narration. Preserve this marker when updating the vendored crate.

The sink receives track identity before playback events or decoded samples. SpotiFlex uses this boundary to discard interrupted selections while keeping automatic track transitions gapless.

Speech downloads use a bounded, account-scoped memory cache with shared pending requests. Music loading and speech preparation run concurrently. Short failure reuse prevents a failed speculative download from immediately adding another synthesis timeout.
