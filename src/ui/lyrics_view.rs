//! Spicy-Lyrics-style renderer: large bold lines, syllable wipe with a soft
//! edge, gentle word lift, depth blur on distant lines, interlude dots and
//! smooth follow scrolling. Timing comes from `crate::lyrics`; this module only draws.

use std::sync::Arc;

use eframe::egui::{self, Align2, Color32, Galley, Id, Pos2, Rect, Sense, Ui, Vec2};

use super::theme;
use crate::lyrics::{Line, Lyrics};

pub struct Style {
    pub size: f32,
    pub reduce_motion: bool,
    pub romanized: bool,
    /// Depth blur for distant lines. Disabled in small views.
    pub blur: bool,
}

#[derive(Default)]
pub struct LyricsView {
    scroll: f32,
    follow: bool,
    initialised: bool,
    content_height: f32,
}

struct Token {
    galley: Arc<Galley>,
    offset: Vec2,
    start_ms: u64,
    end_ms: u64,
}

struct Laid {
    tokens: Vec<Token>,
    translation: Option<Arc<Galley>>,
    height: f32,
    top: f32,
}

const INTERLUDE_MS: u64 = 3_000;

impl LyricsView {
    pub fn reset(&mut self) {
        *self = Self::default();
    }

    pub fn following(&self) -> bool {
        self.follow || !self.initialised
    }

    pub fn resume(&mut self) {
        self.follow = true;
    }

    /// Draw lyrics inside `rect`. Returns a seek position when a synced line is clicked.
    pub fn show(
        &mut self,
        ui: &mut Ui,
        rect: Rect,
        lyrics: &Lyrics,
        position: u64,
        style: &Style,
    ) -> Option<u64> {
        if !self.initialised {
            self.initialised = true;
            self.follow = true;
        }
        let id = ui.id().with(("lyrics", rect.width() as i32));
        let context = ui.ctx().clone();
        let painter = ui.painter_at(rect);
        let padding = Vec2::new((rect.width() * 0.04).clamp(8.0, 40.0), 0.0);
        let width = (rect.width() - padding.x * 2.0).max(80.0);
        let gap = style.size * 0.5;
        let active = lyrics.active_line(position);
        let interlude = interlude(lyrics, position, active);

        // Layout.
        let mut laid: Vec<Laid> = Vec::with_capacity(lyrics.lines.len());
        let mut cursor = rect.height() * 0.38;
        let dots_height = context.animate_value_with_time(
            id.with("interlude"),
            if interlude.is_some() {
                style.size * 1.3
            } else {
                0.0
            },
            if style.reduce_motion { 0.0 } else { 0.3 },
        );
        for (index, line) in lyrics.lines.iter().enumerate() {
            if interlude.map(|(next, _)| next) == Some(index) {
                cursor += dots_height;
            }
            let size = if line.background {
                style.size * 0.68
            } else {
                style.size
            };
            let tokens = layout_tokens(ui, line, size, width, style.romanized);
            let lines_height = tokens
                .iter()
                .map(|token| token.offset.y + token.galley.size().y)
                .fold(0.0, f32::max);
            let translation = (!line.translation.is_empty()).then(|| {
                ui.painter().layout(
                    line.translation.clone(),
                    theme::regular((size * 0.52).max(13.0)),
                    Color32::WHITE,
                    width,
                )
            });
            let height = lines_height
                + translation
                    .as_ref()
                    .map_or(0.0, |galley| galley.size().y + size * 0.15);
            laid.push(Laid {
                tokens,
                translation,
                height,
                top: cursor,
            });
            cursor += height + if line.background { gap * 0.5 } else { gap };
        }
        self.content_height = cursor + rect.height() * 0.5;

        // Scrolling: follow the active line, or let the user browse freely.
        let response = ui.interact(rect, id.with("area"), Sense::click());
        let wheel = if response.hovered() {
            ui.input(|input| input.smooth_scroll_delta.y)
        } else {
            0.0
        };
        let focus = active
            .or(interlude.map(|(next, _)| next))
            .filter(|_| lyrics.synced);
        let target = focus.map(|index| {
            let anchor = if interlude.map(|(next, _)| next) == Some(index) {
                laid[index].top - dots_height
            } else {
                laid[index].top
            };
            anchor - rect.height() * 0.32
        });
        let max_scroll = (self.content_height - rect.height()).max(0.0);
        if wheel != 0.0 {
            self.follow = false;
            self.scroll = (self.scroll - wheel).clamp(0.0, max_scroll);
        } else if self.follow
            && let Some(target) = target
        {
            let target = target.clamp(0.0, max_scroll.max(target));
            if style.reduce_motion {
                self.scroll = target;
            } else {
                let dt = ui.input(|input| input.stable_dt).min(0.1);
                let step = 1.0 - (-dt * 7.0).exp();
                self.scroll += (target - self.scroll) * step;
                if (target - self.scroll).abs() > 0.5 {
                    context.request_repaint();
                } else {
                    self.scroll = target;
                }
            }
        }

        // Painting.
        let origin = rect.min + padding - Vec2::new(0.0, self.scroll);
        let pointer = response.hover_pos();
        let mut seek = None;
        let fade = (rect.height() * 0.14).clamp(24.0, 110.0);
        for (index, (line, layout)) in lyrics.lines.iter().zip(&laid).enumerate() {
            let top = origin.y + layout.top;
            if top > rect.bottom() + 40.0 || top + layout.height < rect.top() - 40.0 {
                continue;
            }
            let line_rect = Rect::from_min_size(
                Pos2::new(rect.left(), top - gap * 0.4),
                Vec2::new(rect.width(), layout.height + gap * 0.8),
            );
            let hovered = lyrics.synced && pointer.is_some_and(|pos| line_rect.contains(pos));
            if hovered && response.clicked() {
                seek = Some(line.start_ms);
                self.follow = true;
            }
            let is_active = active == Some(index)
                || (lyrics.synced
                    && line.background
                    && position >= line.start_ms
                    && position < line.end_ms);
            let emphasis = context.animate_bool_with_time(
                id.with(("line", index)),
                is_active,
                if style.reduce_motion { 0.0 } else { 0.28 },
            );
            let distance = match focus {
                Some(focus) => index.abs_diff(focus) as f32,
                None => 0.0,
            };
            let mut alpha = if !lyrics.synced {
                0.92
            } else {
                let resting = (0.5 - distance * 0.045).max(0.22);
                resting + (1.0 - resting) * emphasis
            };
            if hovered && !is_active {
                alpha = (alpha + 0.3).min(1.0);
            }
            let edge = ((top - rect.top()) / fade)
                .min((rect.bottom() - (top + layout.height)) / fade)
                .clamp(0.0, 1.0);
            alpha *= edge * edge * (3.0 - 2.0 * edge);
            if line.background {
                alpha *= 0.85;
            }
            let blur = if style.blur && !style.reduce_motion && lyrics.synced && !hovered {
                ((distance - 0.5).max(0.0) * 0.9).min(3.2) * (1.0 - emphasis)
            } else {
                0.0
            };
            let line_width = layout
                .tokens
                .iter()
                .map(|token| token.offset.x + token.galley.size().x)
                .fold(0.0, f32::max);
            let x = if line.opposite {
                rect.right() - padding.x - line_width
            } else {
                origin.x
            };
            let synced_words = lyrics.synced && line.words.len() == layout.tokens.len();
            let lift = style.size * 0.045;
            for token in &layout.tokens {
                let progress = if !lyrics.synced {
                    1.0
                } else if synced_words {
                    word_progress(position, token.start_ms, token.end_ms)
                } else if is_active || position >= line.end_ms {
                    1.0
                } else {
                    0.0
                };
                let raise = if style.reduce_motion || !is_active {
                    0.0
                } else {
                    lift * ease(progress) * emphasis
                };
                let pos = Pos2::new(x + token.offset.x, top + token.offset.y - raise);
                if is_active && synced_words {
                    let dim = Color32::from_white_alpha((alpha * 0.42 * 255.0) as u8);
                    painter.galley_with_override_text_color(pos, token.galley.clone(), dim);
                    if progress > 0.0 {
                        wipe(&painter, pos, &token.galley, progress, alpha);
                    }
                } else {
                    let color = Color32::from_white_alpha((alpha * 255.0) as u8);
                    if blur > 0.25 {
                        blurred(&painter, pos, &token.galley, alpha, blur);
                    } else {
                        painter.galley_with_override_text_color(pos, token.galley.clone(), color);
                    }
                }
            }
            if let Some(translation) = &layout.translation {
                let y = top + layout.height - translation.size().y;
                let tx = if line.opposite {
                    rect.right() - padding.x - translation.size().x
                } else {
                    origin.x
                };
                painter.galley_with_override_text_color(
                    Pos2::new(tx, y),
                    translation.clone(),
                    Color32::from_white_alpha((alpha * 0.7 * 255.0) as u8),
                );
            }
            if interlude.map(|(next, _)| next) == Some(index) && dots_height > 1.0 {
                let (_, fraction) = interlude.unwrap_or_default();
                dots(
                    &painter,
                    Pos2::new(origin.x, top - dots_height + style.size * 0.15),
                    style.size,
                    fraction,
                    ui.input(|input| input.time) as f32,
                    dots_height / (style.size * 1.3),
                );
            }
        }
        if hovered_any(&response, lyrics.synced) {
            ui.ctx().set_cursor_icon(egui::CursorIcon::PointingHand);
        }
        seek
    }
}

fn hovered_any(response: &egui::Response, synced: bool) -> bool {
    synced && response.hovered()
}

fn ease(t: f32) -> f32 {
    let t = t.clamp(0.0, 1.0);
    1.0 - (1.0 - t).powi(3)
}

fn word_progress(position: u64, start: u64, end: u64) -> f32 {
    if position <= start {
        0.0
    } else if position >= end {
        1.0
    } else {
        (position - start) as f32 / (end - start).max(1) as f32
    }
}

/// When no line is active and the gap to the next line is long, return the
/// next line's index and the interlude fill fraction.
fn interlude(lyrics: &Lyrics, position: u64, active: Option<usize>) -> Option<(usize, f32)> {
    if !lyrics.synced || active.is_some() {
        return None;
    }
    let next = lyrics
        .lines
        .iter()
        .position(|line| !line.background && line.start_ms > position)?;
    let previous_end = lyrics.lines[..next]
        .iter()
        .map(|line| line.end_ms)
        .max()
        .unwrap_or(0);
    let start = lyrics.lines[next].start_ms;
    if position < previous_end || start.saturating_sub(previous_end) < INTERLUDE_MS {
        return None;
    }
    let fraction = (position - previous_end) as f32 / (start - previous_end).max(1) as f32;
    Some((next, fraction.clamp(0.0, 1.0)))
}

/// Break a line into positioned tokens: one per synced word, or per
/// whitespace-separated chunk for line-synced and static lyrics.
fn layout_tokens(ui: &Ui, line: &Line, size: f32, width: f32, romanized: bool) -> Vec<Token> {
    let font = theme::bold(size);
    let use_words = !line.words.is_empty() && !(romanized && !line.romanization.is_empty());
    let pieces: Vec<(String, u64, u64)> = if use_words {
        line.words
            .iter()
            .map(|word| (word.text.clone(), word.start_ms, word.end_ms))
            .collect()
    } else {
        let text = if romanized && !line.romanization.is_empty() {
            &line.romanization
        } else {
            &line.text
        };
        split_keep_spaces(text)
            .into_iter()
            .map(|piece| (piece, line.start_ms, line.end_ms))
            .collect()
    };
    let painter = ui.painter();
    let row_height = painter
        .layout_no_wrap("Ag".into(), font.clone(), Color32::WHITE)
        .size()
        .y;
    let mut tokens = Vec::with_capacity(pieces.len());
    let mut x = 0.0;
    let mut y = 0.0;
    for (text, start_ms, end_ms) in pieces {
        let mut galley = painter.layout_no_wrap(text.clone(), font.clone(), Color32::WHITE);
        if x > 0.0 && x + galley.size().x > width {
            x = 0.0;
            y += row_height;
            let trimmed = text.trim_start();
            if trimmed.len() != text.len() {
                galley = painter.layout_no_wrap(trimmed.to_owned(), font.clone(), Color32::WHITE);
            }
        }
        if galley.size().x > width {
            // Long unspaced text (common in CJK lyrics): wrap inside the token.
            galley = painter.layout(text.trim().to_owned(), font.clone(), Color32::WHITE, width);
            if x > 0.0 {
                x = 0.0;
                y += row_height;
            }
            let height = galley.size().y;
            tokens.push(Token {
                galley,
                offset: Vec2::new(0.0, y),
                start_ms,
                end_ms,
            });
            y += height;
            continue;
        }
        let advance = galley.size().x;
        tokens.push(Token {
            galley,
            offset: Vec2::new(x, y),
            start_ms,
            end_ms,
        });
        x += advance;
    }
    tokens
}

fn split_keep_spaces(text: &str) -> Vec<String> {
    let mut pieces = Vec::new();
    let mut current = String::new();
    for character in text.chars() {
        if character.is_whitespace() && !current.trim().is_empty() {
            current.push(character);
            pieces.push(std::mem::take(&mut current));
        } else {
            current.push(character);
        }
    }
    if !current.is_empty() {
        pieces.push(current);
    }
    pieces
}

/// Bright fill sweeping left to right with a soft trailing edge.
fn wipe(painter: &egui::Painter, pos: Pos2, galley: &Arc<Galley>, progress: f32, alpha: f32) {
    let size = galley.size();
    let rect = Rect::from_min_size(pos, size);
    let edge = (size.y * 0.35).min(size.x * 0.5);
    let reach = rect.left() + (size.x + edge) * progress;
    let solid = reach - edge;
    let bright = Color32::from_white_alpha((alpha * 255.0) as u8);
    if solid > rect.left() {
        let clip = Rect::from_min_max(rect.min, Pos2::new(solid.min(rect.right()), rect.bottom()));
        painter
            .with_clip_rect(clip)
            .galley_with_override_text_color(pos, galley.clone(), bright);
    }
    let strips = 5;
    for strip in 0..strips {
        let from = solid + edge * strip as f32 / strips as f32;
        let to = solid + edge * (strip + 1) as f32 / strips as f32;
        if to <= rect.left() || from >= rect.right() {
            continue;
        }
        let strength = 1.0 - (strip as f32 + 0.5) / strips as f32;
        let clip = Rect::from_min_max(
            Pos2::new(from.max(rect.left()), rect.top()),
            Pos2::new(to.min(rect.right()), rect.bottom()),
        );
        painter
            .with_clip_rect(clip)
            .galley_with_override_text_color(
                pos,
                galley.clone(),
                Color32::from_white_alpha((alpha * strength * 0.58 * 255.0) as u8),
            );
    }
}

/// Cheap depth-of-field: several faint offset copies approximate a blur.
fn blurred(painter: &egui::Painter, pos: Pos2, galley: &Arc<Galley>, alpha: f32, radius: f32) {
    let copies = 6;
    let each = Color32::from_white_alpha((alpha * 255.0 / (copies as f32 * 0.62)) as u8);
    for copy in 0..copies {
        let angle = copy as f32 / copies as f32 * std::f32::consts::TAU;
        painter.galley_with_override_text_color(
            pos + Vec2::angled(angle) * radius,
            galley.clone(),
            each,
        );
    }
}

fn dots(painter: &egui::Painter, origin: Pos2, size: f32, fraction: f32, time: f32, visible: f32) {
    let radius = size * 0.16;
    let pulse = 1.0 + (time * 2.4).sin() * 0.06;
    for dot in 0..3 {
        let fill = ((fraction * 3.0) - dot as f32).clamp(0.0, 1.0);
        let alpha = (0.3 + 0.7 * fill) * visible.clamp(0.0, 1.0);
        let center = origin + Vec2::new(radius + dot as f32 * radius * 3.0, radius * 1.4);
        painter.circle_filled(
            center,
            radius * pulse * (0.85 + 0.15 * fill),
            Color32::from_white_alpha((alpha * 255.0) as u8),
        );
    }
}

/// Centered status text for empty, loading, or error states.
pub fn message(ui: &Ui, rect: Rect, title: &str, detail: &str) {
    let painter = ui.painter_at(rect);
    painter.text(
        rect.center() - Vec2::new(0.0, 14.0),
        Align2::CENTER_CENTER,
        title,
        theme::bold(26.0),
        Color32::WHITE,
    );
    if !detail.is_empty() {
        painter.text(
            rect.center() + Vec2::new(0.0, 20.0),
            Align2::CENTER_CENTER,
            detail,
            theme::regular(15.0),
            Color32::from_white_alpha(170),
        );
    }
}

pub fn id(name: &str) -> Id {
    Id::new(("spotiflex-lyrics", name))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(start_ms: u64, end_ms: u64) -> Line {
        Line {
            start_ms,
            end_ms,
            text: "la".into(),
            ..Line::default()
        }
    }

    #[test]
    fn interlude_appears_only_in_long_gaps() {
        let lyrics = Lyrics {
            lines: vec![line(0, 2_000), line(2_500, 4_000), line(10_000, 12_000)],
            synced: true,
            ..Lyrics::default()
        };
        assert_eq!(interlude(&lyrics, 2_200, lyrics.active_line(2_200)), None);
        let (next, fraction) = interlude(&lyrics, 7_000, None).unwrap();
        assert_eq!(next, 2);
        assert!((fraction - 0.5).abs() < 0.01);
        assert_eq!(interlude(&lyrics, 11_000, Some(2)), None);
    }

    #[test]
    fn intro_before_first_line_is_an_interlude() {
        let lyrics = Lyrics {
            lines: vec![line(8_000, 9_000)],
            synced: true,
            ..Lyrics::default()
        };
        assert_eq!(
            interlude(&lyrics, 4_000, None).map(|(next, _)| next),
            Some(0)
        );
    }

    #[test]
    fn word_progress_clamps() {
        assert_eq!(word_progress(50, 100, 200), 0.0);
        assert_eq!(word_progress(150, 100, 200), 0.5);
        assert_eq!(word_progress(250, 100, 200), 1.0);
        assert_eq!(word_progress(100, 100, 100), 0.0);
    }

    #[test]
    fn split_keeps_trailing_spaces_with_words() {
        assert_eq!(
            split_keep_spaces("I just  wanna"),
            vec!["I ", "just ", " wanna"]
        );
        assert_eq!(split_keep_spaces("夜に駆ける"), vec!["夜に駆ける"]);
    }
}
