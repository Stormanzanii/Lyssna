// SpotiFlex app icon, rendered from geometry so the window icon, the Windows
// executable icon (see build.rs, which includes this file) and the in-app mark
// stay identical. Keep this file free of crate imports and inner attributes.

/// Equalizer bars as (center x, half height), in unit coordinates.
pub const ICON_BARS: [(f32, f32); 4] = [(0.2, 0.17), (0.4, 0.37), (0.6, 0.25), (0.8, 0.31)];
/// Bar half width, in unit coordinates. Bars are fully rounded.
pub const ICON_BAR_HALF_WIDTH: f32 = 0.078;
/// Corner radius of the legacy in-app tile, in unit coordinates.
pub const ICON_RADIUS: f32 = 0.24;
/// Bar colour of the legacy in-app equalizer mark.
pub const ICON_COLOR: [u8; 3] = [255, 255, 255];

/// Spotify-green disc behind the microphone.
pub const ICON_DISC: [u8; 3] = [30, 215, 96];
/// Microphone colour.
pub const ICON_MIC: [u8; 3] = [0, 0, 0];
/// Lucide's MicVocal strokes (ISC), flattened from its 24-unit view box.
/// Lucide draws 2-unit strokes; the icon thickens them so the mark stays
/// solid at taskbar sizes. Caps and joins are round, as in Lucide.
const MIC_STROKES: [&[(f32, f32)]; 2] = [
    &[
        (11.000, 7.601),
        (5.006, 15.791),
        (4.890, 15.996),
        (4.826, 16.223),
        (4.816, 16.459),
        (4.862, 16.690),
        (4.960, 16.904),
        (5.106, 17.089),
        (5.923, 17.907),
        (6.111, 18.054),
        (6.329, 18.153),
        (6.564, 18.197),
        (6.802, 18.185),
        (7.031, 18.115),
        (7.237, 17.994),
        (15.090, 12.000),
    ],
    &[
        (16.500, 21.174),
        (16.196, 20.977),
        (15.884, 20.793),
        (15.562, 20.623),
        (15.231, 20.470),
        (14.889, 20.334),
        (14.537, 20.219),
        (14.172, 20.126),
        (13.795, 20.057),
        (13.404, 20.015),
        (13.000, 20.000),
        (12.388, 20.066),
        (11.785, 20.242),
        (11.188, 20.499),
        (10.596, 20.807),
        (10.005, 21.134),
        (9.414, 21.450),
        (8.821, 21.725),
        (8.222, 21.929),
        (7.616, 22.031),
        (7.000, 22.000),
        (6.420, 21.818),
        (5.926, 21.504),
        (5.521, 21.085),
        (5.210, 20.588),
        (4.995, 20.041),
        (4.880, 19.470),
        (4.870, 18.903),
        (4.967, 18.368),
        (5.176, 17.891),
        (5.500, 17.500),
    ],
];
/// Half the icon's stroke width, in glyph units.
const MIC_HALF_STROKE: f32 = 1.4;
/// MicVocal's head: a circle of radius 5 at (16, 7).
const MIC_HEAD: (f32, f32, f32) = (16.0, 7.0, 5.0);
/// Centre of the glyph's stroked bounds, placed at the disc centre.
const MIC_CENTRE: (f32, f32) = (13.41, 11.52);
/// Glyph units per icon width; the 23-unit-tall glyph fills 56% of the disc.
const MIC_SCALE: f32 = 0.56 / 23.0;

fn segment_distance(x: f32, y: f32, a: (f32, f32), b: (f32, f32)) -> f32 {
    let (dx, dy) = (b.0 - a.0, b.1 - a.1);
    let t = (((x - a.0) * dx + (y - a.1) * dy) / (dx * dx + dy * dy).max(1e-6)).clamp(0.0, 1.0);
    ((x - a.0 - t * dx).powi(2) + (y - a.1 - t * dy).powi(2)).sqrt()
}

/// True where the microphone covers unit coordinate (x, y).
fn icon_mic(x: f32, y: f32) -> bool {
    let gx = (x - 0.5) / MIC_SCALE + MIC_CENTRE.0;
    let gy = (y - 0.5) / MIC_SCALE + MIC_CENTRE.1;
    let (hx, hy, hr) = MIC_HEAD;
    if (((gx - hx).powi(2) + (gy - hy).powi(2)).sqrt() - hr).abs() <= MIC_HALF_STROKE {
        return true;
    }
    MIC_STROKES.iter().any(|stroke| {
        stroke
            .windows(2)
            .any(|pair| segment_distance(gx, gy, pair[0], pair[1]) <= MIC_HALF_STROKE)
    })
}

/// Straight (non-premultiplied) RGBA pixels, `size` × `size`, 4×4 supersampled:
/// a black microphone on a green disc, transparent outside the disc.
pub fn icon_rgba(size: u32) -> Vec<u8> {
    let samples = 4;
    let total = (samples * samples) as f32;
    let mut pixels = Vec::with_capacity((size * size * 4) as usize);
    for py in 0..size {
        for px in 0..size {
            let (mut disc, mut mic) = (0.0, 0.0);
            for sy in 0..samples {
                for sx in 0..samples {
                    let x = (px as f32 + (sx as f32 + 0.5) / samples as f32) / size as f32;
                    let y = (py as f32 + (sy as f32 + 0.5) / samples as f32) / size as f32;
                    if (x - 0.5).powi(2) + (y - 0.5).powi(2) <= 0.25 {
                        disc += 1.0;
                        if icon_mic(x, y) {
                            mic += 1.0;
                        }
                    }
                }
            }
            let share = if disc > 0.0 { mic / disc } else { 0.0 };
            for channel in 0..3 {
                let value =
                    ICON_DISC[channel] as f32 * (1.0 - share) + ICON_MIC[channel] as f32 * share;
                pixels.push(value.round() as u8);
            }
            pixels.push((disc / total * 255.0).round() as u8);
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
            assert!(
                transparent > 0,
                "Icon corners outside the disc stay transparent"
            );
            assert!(opaque > transparent, "Icon must show the green disc");
        }
    }

    #[test]
    fn disc_is_green_with_a_black_microphone() {
        let size = 128;
        let pixels = icon_rgba(size);
        let at = |x: u32, y: u32| &pixels[((y * size + x) * 4) as usize..][..4];
        // Corners are outside the disc; the edge of the disc is plain green.
        assert_eq!(at(0, 0)[3], 0);
        assert_eq!(at(size / 2, 3)[..3], ICON_DISC);
        let black = pixels
            .chunks(4)
            .filter(|pixel| pixel[3] == 255 && pixel[..3] == ICON_MIC)
            .count();
        assert!(black > 200, "Microphone must be visible");
    }

    /// Regenerates assets/spotiflex.ico: `cargo test write_bundled_icon -- --ignored`.
    #[test]
    #[ignore]
    fn write_bundled_icon() {
        std::fs::write(
            concat!(env!("CARGO_MANIFEST_DIR"), "/assets/spotiflex.ico"),
            ico(&[16, 24, 32, 48, 64, 128, 256]),
        )
        .unwrap();
    }

    #[test]
    fn bundled_icon_matches_shared_geometry_and_encoder() {
        assert_eq!(
            ico(&[16, 24, 32, 48, 64, 128, 256]),
            include_bytes!("../../assets/spotiflex.ico").as_slice(),
        );
    }
}
