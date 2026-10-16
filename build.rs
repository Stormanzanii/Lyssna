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

/// ICO file with uncompressed 32-bit BGRA entries.
fn ico(sizes: &[u32]) -> Vec<u8> {
    let images: Vec<Vec<u8>> = sizes.iter().map(|size| dib(*size)).collect();
    let mut file = Vec::new();
    file.extend_from_slice(&[0, 0, 1, 0]);
    file.extend_from_slice(&(sizes.len() as u16).to_le_bytes());
    let mut offset = 6 + 16 * sizes.len() as u32;
    for (size, image) in sizes.iter().zip(&images) {
        let dimension = if *size >= 256 { 0 } else { *size as u8 };
        file.extend_from_slice(&[dimension, dimension, 0, 0]);
        file.extend_from_slice(&1u16.to_le_bytes());
        file.extend_from_slice(&32u16.to_le_bytes());
        file.extend_from_slice(&(image.len() as u32).to_le_bytes());
        file.extend_from_slice(&offset.to_le_bytes());
        offset += image.len() as u32;
    }
    for image in images {
        file.extend_from_slice(&image);
    }
    file
}

fn dib(size: u32) -> Vec<u8> {
    let rgba = icon_rgba(size);
    let mask_row = size.div_ceil(32) * 4;
    let mut data = Vec::new();
    for value in [40u32, size, size * 2] {
        data.extend_from_slice(&value.to_le_bytes());
    }
    data.extend_from_slice(&1u16.to_le_bytes());
    data.extend_from_slice(&32u16.to_le_bytes());
    data.extend_from_slice(&0u32.to_le_bytes());
    data.extend_from_slice(&(size * size * 4 + mask_row * size).to_le_bytes());
    data.extend_from_slice(&[0; 16]);
    for row in (0..size).rev() {
        for column in 0..size {
            let index = ((row * size + column) * 4) as usize;
            data.extend_from_slice(&[
                rgba[index + 2],
                rgba[index + 1],
                rgba[index],
                rgba[index + 3],
            ]);
        }
    }
    data.extend(std::iter::repeat_n(0, (mask_row * size) as usize));
    data
}
