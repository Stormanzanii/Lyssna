pub mod api;
#[cfg(feature = "legacy-ui")]
pub mod app;
pub mod artist;
mod audio;
pub mod auth;
pub mod config;

pub mod lyrics;
pub mod model;
pub mod native;
pub mod notify;
pub mod provider;
#[cfg(feature = "legacy-ui")]
pub mod ui;
pub mod updater;
pub mod worker;
