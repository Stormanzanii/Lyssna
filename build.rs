// Embed the generated SpotiFlex icon in the Windows executable.

include!("src/ui/icon_pixels.rs");

fn main() {
    println!("cargo:rerun-if-env-changed=SPOTIFLEX_SPICY_LYRICS_KEY");
    if let Ok(key) = std::env::var("SPOTIFLEX_SPICY_LYRICS_KEY")
        && !key.is_empty()
    {
        assert!(
            key.starts_with("sl_pk_")
                && (16..=512).contains(&key.len())
                && key
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"_-".contains(&byte)),
            "SPOTIFLEX_SPICY_LYRICS_KEY must contain a publishable sl_pk_ client key"
        );
    }
    if std::env::var_os("CARGO_FEATURE_DESKTOP").is_some() {
        println!("cargo:rerun-if-changed=dist");
        tauri_build::build();
        return;
    }
    println!("cargo:rerun-if-changed=src/ui/icon_pixels.rs");
    println!("cargo:rerun-if-changed=build.rs");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }
    let out = std::path::PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR"));
    let path = out.join("spotiflex.ico");
    std::fs::write(&path, ico(&[16, 24, 32, 48, 64, 128, 256])).expect("write icon");
    let mut resource = winresource::WindowsResource::new();
    resource.set_icon(path.to_str().expect("icon path"));
    resource.set("ProductName", "SpotiFlex");
    resource.set("FileDescription", "SpotiFlex");
    if let Err(error) = resource.compile() {
        // A missing resource compiler should not block development builds.
        println!("cargo:warning=Executable icon not embedded: {error}");
    }
}
