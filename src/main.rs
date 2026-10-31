#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Checked by a Nightly build before it replaces the running copy.
    if std::env::args().any(|argument| argument == "--version") {
        match lyssna::nightly::COMMIT {
            Some(commit) => println!(
                "Lyssna {} Nightly {}",
                env!("CARGO_PKG_VERSION"),
                &commit[..7.min(commit.len())]
            ),
            None => println!("Lyssna {}", env!("CARGO_PKG_VERSION")),
        }
        return Ok(());
    }
    lyssna::updater::wait_for_previous();
    // Lyssna was SpotiFlex: an install updated in place moves to Lyssna's
    // folder, then SpotiFlex's data moves to Lyssna's names.
    #[cfg(windows)]
    if !std::env::args().any(|argument| matches!(argument.as_str(), "--quit" | "--set-lyrics-host"))
        && lyssna::rename::relocate()
    {
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    if !std::env::args().any(|argument| matches!(argument.as_str(), "--quit" | "--set-lyrics-host"))
        && lyssna::mac_bundle::relocate()
    {
        return Ok(());
    }
    lyssna::rename::migrate();
    #[cfg(windows)]
    lyssna::rename::remove_former_install();
    if std::env::args().any(|argument| argument == "--set-lyrics-host") {
        use std::io::Read;
        let mut host = String::new();
        std::io::stdin().take(2048).read_to_string(&mut host)?;
        let consent = std::env::args().any(|argument| argument == "--allow-spotify-access-token");
        lyssna::provider::configure(host.trim(), consent)?;
        println!("Protected lyrics provider saved.");
        return Ok(());
    }
    let _ = dotenvy::from_filename(".env");
    #[cfg(feature = "desktop")]
    lyssna::desktop::run()?;
    #[cfg(all(not(feature = "desktop"), feature = "legacy-ui"))]
    run_legacy()?;
    Ok(())
}

#[cfg(all(not(feature = "desktop"), feature = "legacy-ui"))]
fn run_legacy() -> Result<(), Box<dyn std::error::Error>> {
    let options = eframe::NativeOptions {
        viewport: eframe::egui::ViewportBuilder::default()
            .with_title("Lyssna")
            .with_inner_size([1440.0, 900.0])
            .with_min_inner_size([760.0, 560.0])
            .with_icon(std::sync::Arc::new(eframe::egui::IconData {
                rgba: lyssna::ui::icon_pixels::icon_rgba(256),
                width: 256,
                height: 256,
            })),
        ..Default::default()
    };
    eframe::run_native(
        "Lyssna",
        options,
        Box::new(|context| Ok(Box::new(lyssna::app::Lyssna::new(context)))),
    )?;
    Ok(())
}
