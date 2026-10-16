// SpotiFlex app icon, rendered from geometry so the window icon, the Windows
// executable icon (see build.rs, which includes this file) and the in-app mark
// stay identical. Keep this file free of crate imports and inner attributes.

/// Equalizer bars as (center x, half height), in unit coordinates.
pub const ICON_BARS: [(f32, f32); 4] = [(0.29, 0.13), (0.43, 0.24), (0.57, 0.17), (0.71, 0.21)];
/// Bar half width and corner radius of the tile, in unit coordinates.
pub const ICON_BAR_HALF_WIDTH: f32 = 0.048;
pub const ICON_RADIUS: f32 = 0.24;
pub const ICON_TOP: [u8; 3] = [167, 139, 250];
pub const ICON_BOTTOM: [u8; 3] = [34, 211, 238];
pub const ICON_BARS_COLOR: [u8; 3] = [10, 10, 18];

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
            let mut tile = 0.0;
            let mut bars = 0.0;
            for sy in 0..samples {
                for sx in 0..samples {
                    let x = (px as f32 + (sx as f32 + 0.5) / samples as f32) / size as f32;
                    let y = (py as f32 + (sy as f32 + 0.5) / samples as f32) / size as f32;
                    if icon_rounded_box(x - 0.5, y - 0.5, 0.47, 0.47, ICON_RADIUS) <= 0.0 {
                        tile += 1.0;
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
            }
            let total = (samples * samples) as f32;
            let coverage = tile / total;
            let bar_share = if tile > 0.0 { bars / tile } else { 0.0 };
            let t = ((px + py) as f32 / (2 * size) as f32).clamp(0.0, 1.0);
            for channel in 0..3 {
                let background = ICON_TOP[channel] as f32
                    + (ICON_BOTTOM[channel] as f32 - ICON_TOP[channel] as f32) * t;
                let value = background + (ICON_BARS_COLOR[channel] as f32 - background) * bar_share;
                pixels.push(value.round() as u8);
            }
            pixels.push((coverage * 255.0).round() as u8);
        }
    }
    pixels
}
