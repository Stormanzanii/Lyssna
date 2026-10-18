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
