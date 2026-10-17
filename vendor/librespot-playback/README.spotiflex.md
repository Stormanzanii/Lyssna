# Local playback adapter

Source: [School-User/librespot](https://github.com/School-User/librespot/tree/b199674d7c241eb82abce494f3f17a9d373b8d23/playback), revision `b199674d7c241eb82abce494f3f17a9d373b8d23`. This is the experimental DJ implementation from upstream pull request 1797.

License: MIT, copyright 2015 Paul Lietar. The upstream license is included as `LICENSE`; distribution notices also appear in the root `THIRD_PARTY_NOTICES.md`.

Only the playback crate is vendored. Other librespot crates remain pinned to the same revision. The manifest replaces workspace inheritance and relative dependency paths with explicit package metadata and dependencies resolved by the application's patches.

SpotiFlex changes tag decoded narration packets. Its audio sink can identify speech when samples reach playback, without treating buffering or paused music as narration. Preserve this marker when updating the vendored crate.
