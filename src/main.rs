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
    let options = eframe::NativeOptions {
        viewport: eframe::egui::ViewportBuilder::default()
            .with_title("SpotiFlex")
            .with_inner_size([1440.0, 900.0])
            .with_min_inner_size([760.0, 560.0]),
        ..Default::default()
    };
    eframe::run_native(
        "SpotiFlex",
        options,
        Box::new(|context| Ok(Box::new(spotiflex::app::SpotiFlex::new(context)))),
    )?;
    Ok(())
}
