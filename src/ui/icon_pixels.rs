// SpotiFlex app icon, rendered from geometry so the window icon, the Windows
// executable icon (see build.rs, which includes this file) and the in-app mark
// stay identical. Keep this file free of crate imports and inner attributes.

/// Equalizer bars as (center x, half height), in unit coordinates.
pub const ICON_BARS: [(f32, f32); 4] = [(0.2, 0.17), (0.4, 0.37), (0.6, 0.25), (0.8, 0.31)];
/// Bar half width, in unit coordinates. Bars are fully rounded.
pub const ICON_BAR_HALF_WIDTH: f32 = 0.078;
/// Corner radius of the legacy in-app tile, in unit coordinates.
pub const ICON_RADIUS: f32 = 0.24;
/// Bar colour. The background stays transparent.
pub const ICON_COLOR: [u8; 3] = [255, 255, 255];

fn icon_rounded_box(x: f32, y: f32, half_x: f32, half_y: f32, radius: f32) -> f32 {
    let qx = x.abs() - half_x + radius;
    let qy = y.abs() - half_y + radius;
    let outside = (qx.max(0.0).powi(2) + qy.max(0.0).powi(2)).sqrt();
    outside + qx.max(qy).min(0.0) - radius
}

/// Straight (non-premultiplied) RGBA pixels, `size` × `size`, 4×4 supersampled.
pub fn icon_rgba(size: u32) -> Vec<u8> {
    let samples = 4;
    let mut pixels = Vec::with_capacity((size * size * 4) as usize);
    for py in 0..size {
        for px in 0..size {
            let mut bars = 0.0;
            for sy in 0..samples {
                for sx in 0..samples {
                    let x = (px as f32 + (sx as f32 + 0.5) / samples as f32) / size as f32;
                    let y = (py as f32 + (sy as f32 + 0.5) / samples as f32) / size as f32;
                    if ICON_BARS.iter().any(|(cx, half)| {
                        icon_rounded_box(
                            x - cx,
                            y - 0.5,
                            ICON_BAR_HALF_WIDTH,
                            *half,
                            ICON_BAR_HALF_WIDTH,
                        ) <= 0.0
                    }) {
                        bars += 1.0;
                    }
                }
            }
            let coverage = bars / (samples * samples) as f32;
            pixels.extend_from_slice(&ICON_COLOR);
            pixels.push((coverage * 255.0).round() as u8);
        }
    }
    pixels
}

/// ICO file with uncompressed 32-bit BGRA entries.
pub fn ico(sizes: &[u32]) -> Vec<u8> {
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
    let mut mask = vec![0; (mask_row * size) as usize];
    for row in (0..size).rev() {
        for column in 0..size {
            let index = ((row * size + column) * 4) as usize;
            if rgba[index + 3] == 0 {
                let offset = ((size - 1 - row) * mask_row + column / 8) as usize;
                mask[offset] |= 0x80 >> (column % 8);
                data.extend_from_slice(&[0, 0, 0, 0]);
                continue;
            }
            data.extend_from_slice(&[
                rgba[index + 2],
                rgba[index + 1],
                rgba[index],
                rgba[index + 3],
            ]);
        }
    }
    data.extend_from_slice(&mask);
    data
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transparent_pixels_support_alpha_and_legacy_icon_readers() {
        for size in [16u32, 24, 32, 48, 64, 128, 256] {
            let image = dib(size);
            let mask_start = 40 + (size * size * 4) as usize;
            let mask_stride = (size.div_ceil(32) * 4) as usize;
            let mut transparent = 0;
            let mut opaque = 0;
            for y in 0..size as usize {
                for x in 0..size as usize {
                    let pixel = 40 + (y * size as usize + x) * 4;
                    let masked =
                        image[mask_start + y * mask_stride + x / 8] & (0x80 >> (x % 8)) != 0;
                    if image[pixel + 3] == 0 {
                        transparent += 1;
                        assert!(
                            masked,
                            "Transparent {size}px icon background has no AND mask"
                        );
                        assert_eq!(&image[pixel..pixel + 3], &[0, 0, 0]);
                    } else {
                        opaque += 1;
                        assert!(!masked, "Icon mask hides visible logo pixels");
                    }
                }
            }
            assert!(transparent > opaque, "Logo must retain transparent padding");
            assert!(opaque > 0, "Logo must retain visible bars");
        }
    }

    #[test]
    fn bundled_icon_matches_shared_geometry_and_encoder() {
        assert_eq!(
            ico(&[16, 24, 32, 48, 64, 128, 256]),
            include_bytes!("../../assets/spotiflex.ico").as_slice(),
        );
    }
}
