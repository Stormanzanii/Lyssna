//! Lyrics renderer modelled on Spicy Lyrics' animator: a critically damped
//! scroll spring that centres the active line, per-word spline curves for
//! scale, lift and glow, a gradient wipe with a soft 20% edge, and depth blur
//! that grows with distance from the active line. Timing comes from
//! `crate::lyrics`; this module only draws.

use std::sync::{Arc, LazyLock};

use eframe::egui::{
    self, Align2, Color32, Galley, Painter, Pos2, Rect, Sense, Shape, Ui, Vec2, emath::TSTransform,
};

use super::{
    motion::{Curve, Spring},
    theme,
};
use crate::lyrics::{Line, Lyrics};

pub struct Style {
    pub size: f32,
    pub reduce_motion: bool,
    pub romanized: bool,
    /// Depth blur for lines away from the active one.
    pub blur: bool,
}

// Curves and opacities follow Spicy Lyrics' default animator preset.
static SCALE: LazyLock<Curve> =
    LazyLock::new(|| Curve::new(&[(0.0, 0.95), (0.7, 1.0505), (1.0, 1.0)]));
static LIFT: LazyLock<Curve> =
    LazyLock::new(|| Curve::new(&[(0.0, 0.01), (0.9, -1.0 / 60.0), (1.0, 0.0)]));
static GLOW: LazyLock<Curve> =
    LazyLock::new(|| Curve::new(&[(0.0, 0.0), (0.15, 1.0), (0.6, 1.0), (1.0, 0.0)]));
const NOT_SUNG_OPACITY: f32 = 0.51;
const SUNG_OPACITY: f32 = 0.497;
const UNSUNG_PART: f32 = 0.38;
// Spicy uses 1.25px per line of CSS text-shadow blur; a disk radius needs
// roughly twice that to look the same.
const BLUR_PER_LINE: f32 = 2.4;
const BLUR_MAX: f32 = 2.4 * 5.465;
const SCROLL_FREQUENCY: f32 = 1.0;
const INTERLUDE_MS: u64 = 3_000;

pub struct LyricsView {
    scroll: Spring,
    follow: bool,
    initialised: bool,
}

impl Default for LyricsView {
    fn default() -> Self {
        Self {
            scroll: Spring::new(0.0, SCROLL_FREQUENCY, 1.0),
            follow: true,
            initialised: false,
        }
    }
}

struct Token {
    galley: Arc<Galley>,
    offset: Vec2,
    start_ms: u64,
    end_ms: u64,
    /// Index of the word this syllable belongs to.
    group: usize,
}

struct Laid {
    tokens: Vec<Token>,
    translation: Option<Arc<Galley>>,
    height: f32,
    top: f32,
}

impl LyricsView {
    pub fn reset(&mut self) {
        *self = Self::default();
    }

    pub fn following(&self) -> bool {
        self.follow
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
        let id = ui.id().with(("lyrics", rect.width() as i32));
        let context = ui.ctx().clone();
        let painter = ui.painter_at(rect);
        let pad = (rect.width() * 0.04).clamp(8.0, 40.0);
        let width = (rect.width() - pad * 2.0).max(80.0);
        let gap = style.size * 0.34;
        let active = lyrics.active_line(position);
        let interlude = interlude(lyrics, position, active);
        let interlude_next = interlude.map(|(next, _)| next);
        let dots_height = context.animate_value_with_time(
            id.with("interlude"),
            if interlude.is_some() {
                style.size * 1.4
            } else {
                0.0
            },
            if style.reduce_motion { 0.0 } else { 0.35 },
        );

        // Layout, in content coordinates.
        let mut laid: Vec<Laid> = Vec::with_capacity(lyrics.lines.len());
        let mut cursor = 0.0;
        for (index, line) in lyrics.lines.iter().enumerate() {
            if interlude_next == Some(index) {
                cursor += dots_height;
            }
            let size = if line.background {
                style.size * 0.68
            } else {
                style.size
            };
            let tokens = layout_tokens(ui, line, size, width, style.romanized);
            let text_height = tokens
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
            let height = text_height
                + translation
                    .as_ref()
                    .map_or(0.0, |galley| galley.size().y + size * 0.1);
            laid.push(Laid {
                tokens,
                translation,
                height,
                top: cursor,
            });
            cursor += height + if line.background { gap * 0.4 } else { gap };
        }
        let content_height = cursor;

        // Scrolling: centre the focus line on a critically damped spring.
        let focus = active.or(interlude_next).filter(|_| lyrics.synced);
        let anchor = rect.height() * 0.45;
        let target = focus.map(|index| {
            let layout = &laid[index];
            if interlude_next == Some(index) {
                layout.top - dots_height / 2.0 - anchor
            } else {
                layout.top + layout.height / 2.0 - anchor
            }
        });
        let response = ui.interact(rect, id.with("area"), Sense::click());
        let wheel = if response.hovered() {
            ui.input(|input| input.smooth_scroll_delta.y)
        } else {
            0.0
        };
        let (min_scroll, max_scroll) = (-anchor, (content_height - anchor).max(-anchor));
        if !self.initialised {
            self.initialised = true;
            self.scroll.snap(target.unwrap_or(-rect.height() * 0.1));
        }
        if wheel != 0.0 {
            self.follow = false;
            let next = (self.scroll.position - wheel).clamp(min_scroll, max_scroll);
            self.scroll.snap(next);
        } else if self.follow {
            if let Some(target) = target {
                self.scroll.goal = target;
            } else if !lyrics.synced {
                self.scroll.goal = self.scroll.goal.clamp(min_scroll, max_scroll);
            }
        }
        if style.reduce_motion {
            self.scroll.snap(self.scroll.goal);
        } else {
            let dt = ui.input(|input| input.stable_dt).min(0.1);
            self.scroll.step(dt);
            if !self.scroll.settled() {
                context.request_repaint();
            }
        }

        // Painting.
        let origin = Pos2::new(rect.left() + pad, rect.top() - self.scroll.position);
        let pointer = response.hover_pos();
        let mut seek = None;
        let blur_scale = (style.size / 40.0).clamp(0.6, 1.6);
        let fade = (rect.height() * 0.1).clamp(16.0, 80.0);
        let time = ui.input(|input| input.time) as f32;
        for (index, (line, layout)) in lyrics.lines.iter().zip(&laid).enumerate() {
            let top = origin.y + layout.top;
            if top > rect.bottom() + 60.0 || top + layout.height < rect.top() - 60.0 {
                continue;
            }
            let line_rect = Rect::from_min_size(
                Pos2::new(rect.left(), top - gap * 0.5),
                Vec2::new(rect.width(), layout.height + gap),
            );
            let hovered = lyrics.synced && pointer.is_some_and(|pos| line_rect.contains(pos));
            if hovered && response.clicked() {
                seek = Some(line.start_ms);
                self.follow = true;
            }
            let is_active = lyrics.synced && position >= line.start_ms && position < line.end_ms;
            let sung = lyrics.synced && position >= line.end_ms;
            let resting = if !lyrics.synced {
                0.9
            } else if is_active {
                1.0
            } else if sung {
                SUNG_OPACITY
            } else {
                NOT_SUNG_OPACITY
            };
            let mut alpha = context.animate_value_with_time(
                id.with(("opacity", index)),
                if hovered { 1.0 } else { resting },
                if style.reduce_motion { 0.0 } else { 0.2 },
            );
            let edge = ((top - rect.top()) / fade)
                .min((rect.bottom() - (top + layout.height)) / fade)
                .clamp(0.0, 1.0);
            alpha *= edge * edge * (3.0 - 2.0 * edge);
            if line.background {
                alpha *= 0.8;
            }
            let distance = match (focus, interlude_next) {
                (Some(focus), Some(next)) if focus == next => index.abs_diff(next) as f32 + 1.0,
                (Some(focus), _) => index.abs_diff(focus) as f32,
                _ => 0.0,
            };
            let blur = if style.blur
                && !style.reduce_motion
                && self.follow
                && lyrics.synced
                && !is_active
                && !hovered
            {
                (BLUR_PER_LINE * distance).min(BLUR_MAX) * blur_scale
            } else {
                0.0
            };
            let line_width = layout
                .tokens
                .iter()
                .map(|token| token.offset.x + token.galley.size().x)
                .fold(0.0, f32::max);
            let x = if line.opposite {
                rect.right() - pad - line_width
            } else {
                origin.x
            };
            let word_synced = lyrics.synced && line.words.len() == layout.tokens.len();
            let line_progress = word_progress(position, line.start_ms, line.end_ms);
            // Split syllables of one word move together: scale and lift follow
            // the whole word's timing around the word's centre.
            let mut groups: Vec<(u64, u64, Rect, bool)> = Vec::new();
            for token in &layout.tokens {
                let rect =
                    Rect::from_min_size(Pos2::new(x, top) + token.offset, token.galley.size());
                match groups.get_mut(token.group) {
                    Some(group) => {
                        group.1 = group.1.max(token.end_ms);
                        group.3 &= (group.2.top() - rect.top()).abs() < 0.5;
                        group.2 = group.2.union(rect);
                    }
                    None => groups.push((token.start_ms, token.end_ms, rect, true)),
                }
            }
            for token in &layout.tokens {
                let progress = if !lyrics.synced {
                    1.0
                } else if word_synced {
                    word_progress(position, token.start_ms, token.end_ms)
                } else {
                    line_progress
                };
                let pos = Pos2::new(x + token.offset.x, top + token.offset.y);
                let (word_start, word_end, word_rect, one_row) = groups[token.group];
                let shared = word_synced && one_row;
                let motion = if shared {
                    word_progress(position, word_start, word_end)
                } else {
                    progress
                };
                let (scale, lift) = if style.reduce_motion || !lyrics.synced {
                    (1.0, 0.0)
                } else {
                    (SCALE.at(motion), LIFT.at(motion) * style.size)
                };
                let word = Word {
                    galley: &token.galley,
                    pos,
                    center: if shared {
                        word_rect.center()
                    } else {
                        Rect::from_min_size(pos, token.galley.size()).center()
                    },
                    scale,
                    lift,
                };
                if is_active {
                    let glow = if style.reduce_motion || motion <= 0.0 || motion >= 1.0 {
                        0.0
                    } else {
                        GLOW.at(motion)
                    };
                    let wipe = if word_synced { progress } else { 1.0 };
                    word.wipe(&painter, wipe, alpha, glow, blur_scale);
                } else {
                    word.paint(&painter, Color32::from_white_alpha(to_byte(alpha)), blur);
                }
            }
            if let Some(translation) = &layout.translation {
                let y = top + layout.height - translation.size().y;
                let tx = if line.opposite {
                    rect.right() - pad - translation.size().x
                } else {
                    origin.x
                };
                let word = Word {
                    galley: translation,
                    pos: Pos2::new(tx, y),
                    center: Pos2::new(tx, y),
                    scale: 1.0,
                    lift: 0.0,
                };
                word.paint(
                    &painter,
                    Color32::from_white_alpha(to_byte(alpha * 0.7)),
                    blur,
                );
            }
            if interlude_next == Some(index) && dots_height > 1.0 {
                let fraction = interlude.map_or(0.0, |(_, fraction)| fraction);
                dots(
                    &painter,
                    Pos2::new(origin.x, top - dots_height),
                    style.size,
                    fraction,
                    time,
                    dots_height / (style.size * 1.4),
                );
            }
        }
        if lyrics.synced && response.hovered() {
            ui.ctx().set_cursor_icon(egui::CursorIcon::PointingHand);
        }
        seek
    }
}

fn to_byte(alpha: f32) -> u8 {
    (alpha.clamp(0.0, 1.0) * 255.0).round() as u8
}

/// One laid-out word with its animated scale (around its centre) and lift.
struct Word<'a> {
    galley: &'a Arc<Galley>,
    pos: Pos2,
    /// Scaling origin: the word's centre, shared by its syllables.
    center: Pos2,
    scale: f32,
    lift: f32,
}

impl Word<'_> {
    fn rect(&self) -> Rect {
        let rect = Rect::from_min_size(self.pos, self.galley.size());
        let transform = self.transform(Vec2::ZERO);
        Rect::from_min_max(transform * rect.min, transform * rect.max)
    }

    fn transform(&self, offset: Vec2) -> TSTransform {
        TSTransform::new(
            self.center.to_vec2() * (1.0 - self.scale) + Vec2::new(0.0, self.lift) + offset,
            self.scale,
        )
    }

    fn shape(&self, offset: Vec2, color: Color32) -> Shape {
        let mut shape =
            Shape::galley_with_override_text_color(self.pos, self.galley.clone(), color);
        shape.transform(self.transform(offset));
        shape
    }

    /// Paint with an approximate Gaussian blur of `radius` points: copies on a
    /// golden-angle disk whose combined opacity at the glyph core equals `color`.
    fn paint(&self, painter: &Painter, color: Color32, radius: f32) {
        if radius < 0.35 {
            painter.add(self.shape(Vec2::ZERO, color));
            return;
        }
        let samples = if radius > 3.0 { 20 } else { 12 };
        let each = 1.0 - (1.0 - color.a() as f32 / 255.0).powf(1.0 / samples as f32 * 1.6);
        let tint = Color32::from_white_alpha(to_byte(each));
        for sample in 0..samples {
            let angle = sample as f32 * 2.399_963;
            let distance = radius * ((sample as f32 + 0.5) / samples as f32).sqrt();
            painter.add(self.shape(Vec2::angled(angle) * distance, tint));
        }
    }

    /// Active word: dim base, bright gradient sweep with a soft edge spanning
    /// 20% of the word, and a glow halo while the word is being sung.
    fn wipe(&self, painter: &Painter, progress: f32, alpha: f32, glow: f32, blur_scale: f32) {
        let rect = self.rect();
        let clip = painter.clip_rect();
        painter.add(self.shape(
            Vec2::ZERO,
            Color32::from_white_alpha(to_byte(alpha * UNSUNG_PART)),
        ));
        if progress <= 0.0 {
            return;
        }
        let solid = rect.left() + rect.width() * (-0.2 + 1.2 * progress);
        let edge = rect.width() * 0.2;
        if glow > 0.01 {
            let halo = Rect::from_min_max(
                rect.min - Vec2::splat(rect.height()),
                Pos2::new(solid + edge * 0.5, rect.bottom() + rect.height()),
            );
            self.paint(
                &painter.with_clip_rect(halo.intersect(clip)),
                Color32::from_white_alpha(to_byte(glow * 0.35 * alpha)),
                (4.0 + 2.0 * glow) * blur_scale,
            );
        }
        let bright = Color32::from_white_alpha(to_byte(alpha));
        if solid > rect.left() {
            let solid_clip = Rect::from_min_max(
                rect.min - Vec2::new(4.0, 8.0),
                Pos2::new(solid.min(rect.right() + 4.0), rect.bottom() + 8.0),
            );
            painter
                .with_clip_rect(solid_clip.intersect(clip))
                .add(self.shape(Vec2::ZERO, bright));
        }
        let strips = 6;
        for strip in 0..strips {
            let from = solid + edge * strip as f32 / strips as f32;
            let to = solid + edge * (strip + 1) as f32 / strips as f32;
            if to <= rect.left() - 4.0 || from >= rect.right() + 4.0 {
                continue;
            }
            let strength = 1.0 - (strip as f32 + 0.5) / strips as f32;
            let strip_clip = Rect::from_min_max(
                Pos2::new(from, rect.top() - 8.0),
                Pos2::new(to, rect.bottom() + 8.0),
            );
            painter
                .with_clip_rect(strip_clip.intersect(clip))
                .add(self.shape(
                    Vec2::ZERO,
                    Color32::from_white_alpha(to_byte(alpha * (1.0 - UNSUNG_PART) * strength)),
                ));
        }
    }
}

/// Interlude dots: each fills, grows and glows in turn, with a slow breath.
fn dots(painter: &Painter, origin: Pos2, size: f32, fraction: f32, time: f32, visible: f32) {
    let radius = size * 0.24;
    let breath = 1.0 + (time * 2.2).sin() * 0.05;
    let visible = visible.clamp(0.0, 1.0);
    for dot in 0..3 {
        let progress = ((fraction * 3.0) - dot as f32).clamp(0.0, 1.0);
        let scale = SCALE.at(progress) * breath * (0.6 + 0.4 * visible);
        let alpha = (0.35 + 0.65 * progress) * visible;
        let center = origin + Vec2::new(radius * 1.2 + dot as f32 * radius * 2.9, size * 0.6);
        let glow = GLOW.at(progress);
        if glow > 0.01 {
            painter.circle_filled(
                center,
                radius * scale * 1.8,
                Color32::from_white_alpha(to_byte(glow * 0.18 * alpha)),
            );
        }
        painter.circle_filled(
            center,
            radius * scale,
            Color32::from_white_alpha(to_byte(alpha)),
        );
    }
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
    let layout = |text: &str| painter.layout_no_wrap(text.to_owned(), font.clone(), Color32::WHITE);
    let row_height = layout("Ag").size().y;
    // Syllables without a leading space continue the previous word; a word
    // only wraps as a whole unless it is wider than the line by itself.
    let mut groups: Vec<Vec<(String, u64, u64)>> = Vec::new();
    for piece in pieces {
        let joins = groups
            .last()
            .and_then(|group| group.last())
            .is_some_and(|previous| {
                !piece.0.starts_with(char::is_whitespace)
                    && !previous.0.ends_with(char::is_whitespace)
            });
        match groups.last_mut() {
            Some(group) if joins => group.push(piece),
            _ => groups.push(vec![piece]),
        }
    }
    let mut tokens = Vec::new();
    let mut x = 0.0;
    let mut y = 0.0;
    for (group_index, group) in groups.into_iter().enumerate() {
        let mut galleys: Vec<Arc<Galley>> = group.iter().map(|piece| layout(&piece.0)).collect();
        let group_width: f32 = galleys.iter().map(|galley| galley.size().x).sum();
        if x > 0.0 && x + group_width > width {
            x = 0.0;
            y += row_height;
            let trimmed = group[0].0.trim_start();
            if trimmed.len() != group[0].0.len() {
                galleys[0] = layout(trimmed);
            }
        }
        for ((text, start_ms, end_ms), mut galley) in group.into_iter().zip(galleys) {
            if x > 0.0 && x + galley.size().x > width {
                x = 0.0;
                y += row_height;
                galley = layout(text.trim_start());
            }
            if galley.size().x > width {
                // A single unbreakable syllable wider than the line.
                galley =
                    painter.layout(text.trim().to_owned(), font.clone(), Color32::WHITE, width);
                let height = galley.size().y;
                tokens.push(Token {
                    galley,
                    offset: Vec2::new(0.0, y),
                    start_ms,
                    end_ms,
                    group: group_index,
                });
                y += height;
                x = 0.0;
                continue;
            }
            let advance = galley.size().x;
            tokens.push(Token {
                galley,
                offset: Vec2::new(x, y),
                start_ms,
                end_ms,
                group: group_index,
            });
            x += advance;
        }
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
