//! Vector icons painted with egui shapes, so no icon font or image assets are needed.

use eframe::egui::{
    self, Align2, Color32, Painter, Pos2, Rect, Response, Sense, Shape, Stroke, Ui, Vec2,
    epaint::{CircleShape, Mesh, PathShape, PathStroke},
};

use super::theme::{self, GREEN, SUBDUED, TEXT};

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Icon {
    Home,
    Search,
    Library,
    Plus,
    Play,
    Pause,
    Next,
    Previous,
    Shuffle,
    Repeat,
    RepeatOne,
    Heart,
    Volume(u8),
    Lyrics,
    NowPlaying,
    Queue,
    Devices,
    Settings,
    Back,
    Forward,
    Fullscreen,
    ExitFullscreen,
    Close,
    Refresh,
    Check,
    Clock,
    Music,
    More,
    Collapse,
}

pub fn paint(painter: &Painter, rect: Rect, icon: Icon, color: Color32) {
    let size = rect.width().min(rect.height());
    let rect = Rect::from_center_size(rect.center(), Vec2::splat(size));
    let p = |x: f32, y: f32| rect.min + Vec2::new(x * size, y * size);
    let width = (size * 0.085).max(1.3);
    let stroke = Stroke::new(width, color);
    let line = |points: Vec<Pos2>| {
        painter.add(Shape::line(points, stroke));
    };
    let fill = |points: Vec<Pos2>| {
        painter.add(Shape::convex_polygon(points, color, Stroke::NONE));
    };
    match icon {
        Icon::Home => {
            line(vec![p(0.12, 0.48), p(0.5, 0.14), p(0.88, 0.48)]);
            line(vec![
                p(0.24, 0.4),
                p(0.24, 0.86),
                p(0.42, 0.86),
                p(0.42, 0.62),
                p(0.58, 0.62),
                p(0.58, 0.86),
                p(0.76, 0.86),
                p(0.76, 0.4),
            ]);
        }
        Icon::Search => {
            painter.circle_stroke(p(0.43, 0.43), size * 0.27, stroke);
            line(vec![p(0.63, 0.63), p(0.86, 0.86)]);
        }
        Icon::Library => {
            line(vec![p(0.18, 0.14), p(0.18, 0.86)]);
            line(vec![p(0.38, 0.14), p(0.38, 0.86)]);
            line(vec![p(0.55, 0.18), p(0.8, 0.84)]);
        }
        Icon::Plus => {
            line(vec![p(0.5, 0.18), p(0.5, 0.82)]);
            line(vec![p(0.18, 0.5), p(0.82, 0.5)]);
        }
        Icon::Play => fill(vec![p(0.28, 0.16), p(0.84, 0.5), p(0.28, 0.84)]),
        Icon::Pause => {
            for x in [0.26, 0.58] {
                painter.rect_filled(
                    Rect::from_min_max(p(x, 0.16), p(x + 0.16, 0.84)),
                    size * 0.03,
                    color,
                );
            }
        }
        Icon::Next | Icon::Previous => {
            let mirror = icon == Icon::Previous;
            let q = |x: f32, y: f32| if mirror { p(1.0 - x, y) } else { p(x, y) };
            fill(vec![q(0.18, 0.18), q(0.68, 0.5), q(0.18, 0.82)]);
            painter.rect_filled(
                Rect::from_two_pos(q(0.7, 0.18), q(0.82, 0.82)),
                size * 0.02,
                color,
            );
        }
        Icon::Shuffle => {
            line(vec![
                p(0.1, 0.28),
                p(0.32, 0.28),
                p(0.66, 0.72),
                p(0.86, 0.72),
            ]);
            line(vec![
                p(0.1, 0.72),
                p(0.32, 0.72),
                p(0.66, 0.28),
                p(0.86, 0.28),
            ]);
            line(vec![p(0.74, 0.16), p(0.88, 0.28), p(0.74, 0.4)]);
            line(vec![p(0.74, 0.6), p(0.88, 0.72), p(0.74, 0.84)]);
        }
        Icon::Repeat | Icon::RepeatOne => {
            painter.rect_stroke(
                Rect::from_min_max(p(0.12, 0.28), p(0.88, 0.76)),
                size * 0.16,
                stroke,
                egui::StrokeKind::Middle,
            );
            line(vec![p(0.52, 0.16), p(0.64, 0.28), p(0.52, 0.4)]);
            if icon == Icon::RepeatOne {
                painter.circle_filled(p(0.82, 0.18), size * 0.17, color);
                painter.text(
                    p(0.82, 0.18),
                    Align2::CENTER_CENTER,
                    "1",
                    theme::bold(size * 0.24),
                    Color32::BLACK,
                );
            }
        }
        Icon::Heart => {
            let points: Vec<Pos2> = (0..48)
                .map(|step| {
                    let t = step as f32 / 48.0 * std::f32::consts::TAU;
                    let x = 16.0 * t.sin().powi(3);
                    let y = 13.0 * t.cos()
                        - 5.0 * (2.0 * t).cos()
                        - 2.0 * (3.0 * t).cos()
                        - (4.0 * t).cos();
                    p(0.5 + x / 38.0, 0.46 - y / 38.0)
                })
                .collect();
            let mut mesh = Mesh::default();
            mesh.colored_vertex(p(0.5, 0.5), color);
            for point in &points {
                mesh.colored_vertex(*point, color);
            }
            let count = points.len() as u32;
            for index in 0..count {
                mesh.add_triangle(0, index + 1, (index + 1) % count + 1);
            }
            painter.add(Shape::mesh(mesh));
        }
        Icon::Volume(level) => {
            fill(vec![
                p(0.1, 0.38),
                p(0.26, 0.38),
                p(0.46, 0.18),
                p(0.46, 0.82),
                p(0.26, 0.62),
                p(0.1, 0.62),
            ]);
            if level == 0 {
                line(vec![p(0.6, 0.38), p(0.84, 0.62)]);
                line(vec![p(0.84, 0.38), p(0.6, 0.62)]);
            } else {
                arc(painter, p(0.46, 0.5), size * 0.17, -0.8, 0.8, stroke);
                if level > 33 {
                    arc(painter, p(0.46, 0.5), size * 0.3, -0.85, 0.85, stroke);
                }
                if level > 66 {
                    arc(painter, p(0.46, 0.5), size * 0.43, -0.9, 0.9, stroke);
                }
            }
        }
        Icon::Lyrics => {
            painter.rect_stroke(
                Rect::from_min_max(p(0.36, 0.1), p(0.64, 0.56)),
                size * 0.14,
                stroke,
                egui::StrokeKind::Middle,
            );
            arc(
                painter,
                p(0.5, 0.42),
                size * 0.26,
                0.25 * std::f32::consts::PI,
                0.75 * std::f32::consts::PI,
                stroke,
            );
            line(vec![p(0.5, 0.68), p(0.5, 0.88)]);
            line(vec![p(0.34, 0.88), p(0.66, 0.88)]);
        }
        Icon::NowPlaying => {
            painter.rect_stroke(
                Rect::from_min_max(p(0.1, 0.16), p(0.9, 0.84)),
                size * 0.08,
                stroke,
                egui::StrokeKind::Middle,
            );
            painter.rect_filled(
                Rect::from_min_max(p(0.56, 0.26), p(0.8, 0.74)),
                size * 0.04,
                color,
            );
        }
        Icon::Queue => {
            line(vec![p(0.12, 0.22), p(0.88, 0.22)]);
            line(vec![p(0.12, 0.44), p(0.88, 0.44)]);
            line(vec![p(0.12, 0.66), p(0.5, 0.66)]);
            fill(vec![p(0.62, 0.58), p(0.88, 0.74), p(0.62, 0.9)]);
        }
        Icon::Devices => {
            painter.rect_stroke(
                Rect::from_min_max(p(0.24, 0.1), p(0.76, 0.9)),
                size * 0.08,
                stroke,
                egui::StrokeKind::Middle,
            );
            painter.circle_stroke(p(0.5, 0.6), size * 0.14, stroke);
            painter.circle_filled(p(0.5, 0.28), size * 0.05, color);
        }
        Icon::Settings => {
            painter.circle_stroke(p(0.5, 0.5), size * 0.13, stroke);
            painter.circle_stroke(p(0.5, 0.5), size * 0.3, stroke);
            for tooth in 0..8 {
                let angle = tooth as f32 / 8.0 * std::f32::consts::TAU;
                let direction = Vec2::angled(angle);
                line(vec![
                    p(0.5, 0.5) + direction * size * 0.3,
                    p(0.5, 0.5) + direction * size * 0.43,
                ]);
            }
        }
        Icon::Back => line(vec![p(0.62, 0.16), p(0.3, 0.5), p(0.62, 0.84)]),
        Icon::Forward => line(vec![p(0.38, 0.16), p(0.7, 0.5), p(0.38, 0.84)]),
        Icon::Collapse => {
            line(vec![p(0.52, 0.2), p(0.22, 0.5), p(0.52, 0.8)]);
            line(vec![p(0.8, 0.2), p(0.8, 0.8)]);
        }
        Icon::Fullscreen => {
            for (corner, dx, dy) in [
                (p(0.14, 0.14), 1.0, 1.0),
                (p(0.86, 0.14), -1.0, 1.0),
                (p(0.14, 0.86), 1.0, -1.0),
                (p(0.86, 0.86), -1.0, -1.0),
            ] {
                line(vec![
                    corner + Vec2::new(dx * size * 0.24, 0.0),
                    corner,
                    corner + Vec2::new(0.0, dy * size * 0.24),
                ]);
            }
        }
        Icon::ExitFullscreen => {
            for (corner, dx, dy) in [
                (p(0.38, 0.38), -1.0, -1.0),
                (p(0.62, 0.38), 1.0, -1.0),
                (p(0.38, 0.62), -1.0, 1.0),
                (p(0.62, 0.62), 1.0, 1.0),
            ] {
                line(vec![
                    corner + Vec2::new(dx * size * 0.24, 0.0),
                    corner,
                    corner + Vec2::new(0.0, dy * size * 0.24),
                ]);
            }
        }
        Icon::Close => {
            line(vec![p(0.2, 0.2), p(0.8, 0.8)]);
            line(vec![p(0.8, 0.2), p(0.2, 0.8)]);
        }
        Icon::Refresh => {
            arc(painter, p(0.5, 0.5), size * 0.32, -1.2, 4.2, stroke);
            fill(vec![p(0.64, 0.06), p(0.86, 0.22), p(0.6, 0.34)]);
        }
        Icon::Check => {
            painter.add(CircleShape::filled(p(0.5, 0.5), size * 0.46, GREEN));
            painter.add(Shape::line(
                vec![p(0.3, 0.5), p(0.44, 0.64), p(0.7, 0.36)],
                Stroke::new(width * 1.1, Color32::BLACK),
            ));
        }
        Icon::Clock => {
            painter.circle_stroke(p(0.5, 0.5), size * 0.38, stroke);
            line(vec![p(0.5, 0.26), p(0.5, 0.5), p(0.66, 0.6)]);
        }
        Icon::Music => {
            painter.circle_filled(p(0.34, 0.72), size * 0.14, color);
            line(vec![p(0.46, 0.72), p(0.46, 0.14), p(0.76, 0.26)]);
        }
        Icon::More => {
            for x in [0.2, 0.5, 0.8] {
                painter.circle_filled(p(x, 0.5), size * 0.075, color);
            }
        }
    }
}

fn arc(painter: &Painter, center: Pos2, radius: f32, from: f32, to: f32, stroke: Stroke) {
    let steps = 18;
    let points = (0..=steps)
        .map(|step| center + Vec2::angled(from + (to - from) * step as f32 / steps as f32) * radius)
        .collect();
    painter.add(PathShape::line(points, PathStroke::from(stroke)));
}

/// Borderless icon button. Hover brightens; `active` paints the icon green
/// with a small indicator dot, matching Spotify's toggle buttons.
pub fn button(ui: &mut Ui, icon: Icon, size: f32, active: bool, tooltip: &str) -> Response {
    let (rect, response) = ui.allocate_exact_size(Vec2::splat(size + 12.0), Sense::click());
    paint_button(ui, rect, response, icon, size, active, tooltip)
}

/// Icon button at a fixed rectangle, for custom-painted bars.
pub fn button_at(
    ui: &Ui,
    rect: Rect,
    id: egui::Id,
    icon: Icon,
    size: f32,
    active: bool,
    tooltip: &str,
) -> Response {
    let response = ui.interact(rect, id, Sense::click());
    paint_button(ui, rect, response, icon, size, active, tooltip)
}

fn paint_button(
    ui: &Ui,
    rect: Rect,
    response: Response,
    icon: Icon,
    size: f32,
    active: bool,
    tooltip: &str,
) -> Response {
    let hovered = response.hovered();
    let color = if active {
        if hovered { theme::GREEN_HOVER } else { GREEN }
    } else if hovered {
        TEXT
    } else {
        SUBDUED
    };
    let scale = if response.is_pointer_button_down_on() {
        0.92
    } else {
        1.0
    };
    paint(
        ui.painter(),
        Rect::from_center_size(rect.center(), Vec2::splat(size * scale)),
        icon,
        color,
    );
    if active {
        ui.painter()
            .circle_filled(rect.center_bottom() - Vec2::new(0.0, 1.0), 2.0, GREEN);
    }
    if tooltip.is_empty() {
        response
    } else {
        response.on_hover_text(tooltip)
    }
}

/// Filled circular button, e.g. the white play button or green context play.
pub fn round_button(
    ui: &mut Ui,
    icon: Icon,
    diameter: f32,
    fill: Color32,
    glyph: Color32,
    tooltip: &str,
) -> Response {
    let (rect, response) = ui.allocate_exact_size(Vec2::splat(diameter), Sense::click());
    round_button_at(ui, rect, &response, icon, fill, glyph);
    response.on_hover_text(tooltip)
}

pub fn round_button_at(
    ui: &Ui,
    rect: Rect,
    response: &Response,
    icon: Icon,
    fill: Color32,
    glyph: Color32,
) {
    let grow = ui
        .ctx()
        .animate_bool_with_time(response.id.with("grow"), response.hovered(), 0.12);
    let shrink = if response.is_pointer_button_down_on() {
        0.94
    } else {
        1.0
    };
    let radius = rect.width() / 2.0 * (1.0 + grow * 0.05) * shrink;
    ui.painter().circle_filled(rect.center(), radius, fill);
    let icon_size = rect.width() * 0.42;
    let offset = if icon == Icon::Play {
        Vec2::new(rect.width() * 0.03, 0.0)
    } else {
        Vec2::ZERO
    };
    paint(
        ui.painter(),
        Rect::from_center_size(rect.center() + offset, Vec2::splat(icon_size)),
        icon,
        glyph,
    );
}
