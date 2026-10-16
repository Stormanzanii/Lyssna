#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() -> Result<(), Box<dyn std::error::Error>> {
    if std::env::args().any(|argument| argument == "--set-lyrics-host") {
        use std::io::Read;
        let mut host = String::new();
        std::io::stdin().take(2048).read_to_string(&mut host)?;
        let consent = std::env::args().any(|argument| argument == "--allow-spotify-access-token");
        spotiflex::provider::configure(host.trim(), consent)?;
        println!("Protected lyrics provider saved.");
        return Ok(());
    }
    let _ = dotenvy::from_filename(".env");
    #[cfg(feature = "desktop")]
    spotiflex::desktop::run()?;
    #[cfg(all(not(feature = "desktop"), feature = "legacy-ui"))]
    run_legacy()?;
    Ok(())
}

#[cfg(all(not(feature = "desktop"), feature = "legacy-ui"))]
fn run_legacy() -> Result<(), Box<dyn std::error::Error>> {
    let options = eframe::NativeOptions {
        viewport: eframe::egui::ViewportBuilder::default()
            .with_title("SpotiFlex")
            .with_inner_size([1440.0, 900.0])
            .with_min_inner_size([760.0, 560.0])
            .with_icon(std::sync::Arc::new(eframe::egui::IconData {
                rgba: spotiflex::ui::icon_pixels::icon_rgba(256),
                width: 256,
                height: 256,
            })),
        ..Default::default()
    };
    eframe::run_native(
        "SpotiFlex",
        options,
        Box::new(|context| Ok(Box::new(spotiflex::app::SpotiFlex::new(context)))),
    )?;
    Ok(())
}
