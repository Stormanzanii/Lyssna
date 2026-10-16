use std::sync::Arc;

use eframe::egui::{
    self, Color32, FontFamily, FontId, Galley, Pos2, Rect, Stroke, Ui, Vec2,
    epaint::{Mesh, Shape},
    text::{LayoutJob, TextFormat, TextWrapping},
};

// SpotiFlex palette: Spotify's layout, its own look. Violet accent with a
// cyan partner, and slightly cool, blue-tinted surfaces.
pub const ACCENT: Color32 = Color32::from_rgb(167, 139, 250);
pub const ACCENT_HOVER: Color32 = Color32::from_rgb(196, 181, 253);
pub const ACCENT_ALT: Color32 = Color32::from_rgb(34, 211, 238);
pub const BASE: Color32 = Color32::from_rgb(7, 7, 12);
pub const SURFACE: Color32 = Color32::from_rgb(17, 17, 25);
pub const ELEVATED: Color32 = Color32::from_rgb(28, 28, 40);
pub const HIGHLIGHT: Color32 = Color32::from_rgb(40, 40, 56);
pub const TEXT: Color32 = Color32::from_rgb(244, 244, 250);
pub const SUBDUED: Color32 = Color32::from_rgb(163, 163, 186);
pub const FAINT: Color32 = Color32::from_rgb(105, 105, 128);
pub const ERROR: Color32 = Color32::from_rgb(248, 113, 133);
pub const RADIUS: u8 = 14;
pub const GAP: f32 = 8.0;

const BOLD: &str = "bold";

pub fn bold(size: f32) -> FontId {
    FontId::new(size, FontFamily::Name(BOLD.into()))
}

pub fn regular(size: f32) -> FontId {
    FontId::proportional(size)
}

/// Install colours, spacing and fonts. Fonts are optional: missing system
/// files fall back to egui's bundled fonts so the bold family always exists.
pub fn install(context: &egui::Context) {
    let mut visuals = egui::Visuals::dark();
    visuals.panel_fill = BASE;
    visuals.window_fill = ELEVATED;
    visuals.window_stroke = Stroke::new(1.0_f32, Color32::from_white_alpha(14));
    visuals.window_corner_radius = 12.into();
    visuals.menu_corner_radius = 8.into();
    visuals.extreme_bg_color = Color32::from_rgb(34, 34, 48);
    visuals.faint_bg_color = Color32::from_white_alpha(6);
    visuals.hyperlink_color = ACCENT;
    visuals.selection.bg_fill = Color32::from_rgb(76, 60, 140);
    visuals.selection.stroke = Stroke::new(1.0_f32, ACCENT);
    visuals.slider_trailing_fill = true;
    visuals.handle_shape = egui::style::HandleShape::Circle;
    for (widget, fill) in [
        (&mut visuals.widgets.inactive, HIGHLIGHT),
        (&mut visuals.widgets.hovered, Color32::from_rgb(54, 54, 74)),
        (&mut visuals.widgets.active, Color32::from_rgb(66, 66, 90)),
        (&mut visuals.widgets.open, Color32::from_rgb(54, 54, 74)),
    ] {
        widget.bg_fill = fill;
        widget.weak_bg_fill = fill;
        widget.corner_radius = 18.into();
        widget.bg_stroke = Stroke::NONE;
    }
    visuals.widgets.inactive.fg_stroke = Stroke::new(1.0_f32, TEXT);
    visuals.widgets.hovered.fg_stroke = Stroke::new(1.5_f32, TEXT);
    visuals.widgets.active.fg_stroke = Stroke::new(1.5_f32, TEXT);
    visuals.widgets.noninteractive.bg_stroke = Stroke::new(1.0_f32, Color32::from_white_alpha(18));
    visuals.widgets.noninteractive.fg_stroke = Stroke::new(1.0_f32, SUBDUED);
    visuals.widgets.noninteractive.corner_radius = 8.into();
    context.set_visuals(visuals);
    context.style_mut(|style| {
        style.spacing.item_spacing = Vec2::new(10.0, 10.0);
        style.spacing.button_padding = Vec2::new(16.0, 8.0);
        style.spacing.interact_size.y = 32.0;
        style.spacing.slider_rail_height = 4.0;
        style.spacing.scroll = egui::style::ScrollStyle::floating();
        style.spacing.scroll.floating_allocated_width = 0.0;
        for (text_style, font) in [
            (egui::TextStyle::Body, regular(14.5)),
            (egui::TextStyle::Button, regular(14.0)),
            (egui::TextStyle::Small, regular(12.0)),
            (egui::TextStyle::Heading, bold(24.0)),
            (egui::TextStyle::Monospace, FontId::monospace(13.5)),
        ] {
            style.text_styles.insert(text_style, font);
        }
    });

    let mut fonts = egui::FontDefinitions::default();
    let fallback = fonts
        .families
        .get(&FontFamily::Proportional)
        .cloned()
        .unwrap_or_default();
    let mut regular_family = Vec::new();
    let mut bold_family = Vec::new();
    // Bold weight first, then CJK coverage so Japanese and Korean lyrics render,
    // then emoji (drawn monochrome; egui has no colour font support).
    for (name, file, is_bold) in [
        ("segoe", "segoeui.ttf", false),
        ("segoe-bold", "segoeuib.ttf", true),
        ("yugothic", "YuGothM.ttc", false),
        ("yugothic-bold", "YuGothB.ttc", true),
        ("malgun", "malgun.ttf", false),
        ("malgun-bold", "malgunbd.ttf", true),
        ("segoe-emoji", "seguiemj.ttf", false),
        ("segoe-symbol", "seguisym.ttf", false),
    ] {
        let Ok(bytes) = std::fs::read(format!("C:\\Windows\\Fonts\\{file}")) else {
            continue;
        };
        fonts
            .font_data
            .insert(name.into(), Arc::new(egui::FontData::from_owned(bytes)));
        if is_bold {
            bold_family.push(name.to_owned());
        } else {
            regular_family.push(name.to_owned());
        }
    }
    bold_family.extend(regular_family.iter().cloned());
    bold_family.extend(fallback.iter().cloned());
    regular_family.extend(fallback);
    fonts
        .families
        .insert(FontFamily::Proportional, regular_family);
    fonts
        .families
        .insert(FontFamily::Name(BOLD.into()), bold_family);
    context.set_fonts(fonts);
}

/// Single-line text truncated with an ellipsis.
pub fn line(ui: &Ui, text: &str, font: FontId, color: Color32, width: f32) -> Arc<Galley> {
    let mut job = LayoutJob::single_section(text.to_owned(), TextFormat::simple(font, color));
    job.wrap = TextWrapping::truncate_at_width(width.max(1.0));
    ui.painter().layout_job(job)
}

/// Paint single-line text and return its rectangle.
pub fn text(ui: &Ui, pos: Pos2, text: &str, font: FontId, color: Color32, width: f32) -> Rect {
    let galley = line(ui, text, font, color, width);
    let rect = Rect::from_min_size(pos, galley.size());
    super::emoji::paint_galley(ui.painter(), pos, galley, color);
    rect
}

pub fn vertical_gradient(painter: &egui::Painter, rect: Rect, top: Color32, bottom: Color32) {
    let mut mesh = Mesh::default();
    mesh.colored_vertex(rect.left_top(), top);
    mesh.colored_vertex(rect.right_top(), top);
    mesh.colored_vertex(rect.left_bottom(), bottom);
    mesh.colored_vertex(rect.right_bottom(), bottom);
    mesh.add_triangle(0, 1, 2);
    mesh.add_triangle(1, 2, 3);
    painter.add(Shape::mesh(mesh));
}

/// Cover the square corners of `rect` with `color`, producing rounded corners
/// for content (such as rotated artwork) that cannot be clipped to a radius.
pub fn mask_corners(painter: &egui::Painter, rect: Rect, radius: f32, color: Color32) {
    let corners = [
        (
            rect.left_top(),
            Vec2::new(radius, radius),
            std::f32::consts::PI,
        ),
        (
            rect.right_top(),
            Vec2::new(-radius, radius),
            1.5 * std::f32::consts::PI,
        ),
        (rect.right_bottom(), Vec2::new(-radius, -radius), 0.0),
        (
            rect.left_bottom(),
            Vec2::new(radius, -radius),
            0.5 * std::f32::consts::PI,
        ),
    ];
    for (corner, inward, start) in corners {
        let center = corner + inward;
        let mut mesh = Mesh::default();
        mesh.colored_vertex(corner, color);
        let steps = 8;
        for step in 0..=steps {
            let angle = start + step as f32 / steps as f32 * std::f32::consts::FRAC_PI_2;
            mesh.colored_vertex(center + Vec2::angled(angle) * radius, color);
        }
        for step in 1..=steps as u32 {
            mesh.add_triangle(0, step, step + 1);
        }
        painter.add(Shape::mesh(mesh));
    }
}

pub fn lerp_color(from: Color32, to: Color32, t: f32) -> Color32 {
    let t = t.clamp(0.0, 1.0);
    let mix = |a: u8, b: u8| (a as f32 + (b as f32 - a as f32) * t).round() as u8;
    Color32::from_rgba_premultiplied(
        mix(from.r(), to.r()),
        mix(from.g(), to.g()),
        mix(from.b(), to.b()),
        mix(from.a(), to.a()),
    )
}

/// Deterministic accent colour for items without artwork colour data.
pub fn accent_for(seed: &str) -> Color32 {
    let hash = seed.bytes().fold(2_166_136_261_u32, |hash, byte| {
        (hash ^ byte as u32).wrapping_mul(16_777_619)
    });
    let hue = (hash % 360) as f32 / 360.0;
    egui::ecolor::Hsva::new(hue, 0.55, 0.55, 1.0).into()
}

pub fn time_text(milliseconds: u64) -> String {
    let seconds = milliseconds / 1000;
    format!("{}:{:02}", seconds / 60, seconds % 60)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn time_text_pads_seconds() {
        assert_eq!(time_text(0), "0:00");
        assert_eq!(time_text(61_500), "1:01");
        assert_eq!(time_text(3_600_000), "60:00");
    }

    #[test]
    fn accent_is_stable_per_seed() {
        assert_eq!(accent_for("abc"), accent_for("abc"));
        assert_ne!(accent_for("abc"), accent_for("abd"));
    }
}
