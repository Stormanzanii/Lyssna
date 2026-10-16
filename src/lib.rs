pub mod album;
pub mod api;
#[cfg(feature = "legacy-ui")]
pub mod app;
pub mod artist;
mod audio;
pub mod auth;
pub mod canvas;
pub mod catalogue;
pub mod config;
#[cfg(feature = "desktop")]
pub mod desktop;
pub mod lyrics;
pub mod model;
pub mod native;
pub mod notify;
mod playback_intent;
pub mod provider;
pub mod resume;
pub mod track_facts;
#[cfg(feature = "legacy-ui")]
pub mod ui;
pub mod updater;
pub mod worker;
