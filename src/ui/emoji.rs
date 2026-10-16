//! Colour emoji. egui's font atlas is monochrome, so emoji drawn from fonts
//! take the text colour. This module rasterizes the colour layers (COLR/CPAL)
//! of the system emoji font into textures and paints them over the emoji
//! glyphs of a laid-out galley, hiding the monochrome glyph underneath.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock},
};

use eframe::egui::{
    self, Color32, ColorImage, Galley, Painter, Pos2, Rect, TextureHandle, TextureOptions, Vec2,
};
use tiny_skia::{
    BlendMode, FillRule, GradientStop, LinearGradient, Mask, Paint, PathBuilder, Pixmap,
    PixmapPaint, Point, RadialGradient, Shader, SpreadMode, Transform,
};
use ttf_parser::{
    Face, GlyphId, OutlineBuilder, RgbaColor,
    colr::{ClipBox, CompositeMode, Paint as ColrPaint, Painter as ColrPainter},
};

const RASTER: u32 = 72;
const FONT_PATH: &str = "C:\\Windows\\Fonts\\seguiemj.ttf";

struct EmojiFont {
    data: &'static [u8],
    textures: Mutex<HashMap<char, Option<TextureHandle>>>,
}

fn font() -> Option<&'static EmojiFont> {
    static FONT: OnceLock<Option<EmojiFont>> = OnceLock::new();
    FONT.get_or_init(|| {
        let bytes = std::fs::read(FONT_PATH).ok()?;
        // Parsed faces borrow the bytes; the font lives for the whole process.
        let data: &'static [u8] = Box::leak(bytes.into_boxed_slice());
        Face::parse(data, 0).ok()?;
        Some(EmojiFont {
            data,
            textures: Mutex::new(HashMap::new()),
        })
    })
    .as_ref()
}

/// Cheap pre-filter so plain text skips the per-glyph pass.
pub fn maybe_emoji(character: char) -> bool {
    matches!(character as u32,
        0x2190..=0x21FF | 0x2300..=0x23FF | 0x2460..=0x27BF | 0x2900..=0x297F
        | 0x2B00..=0x2BFF | 0x3030 | 0x303D | 0x3297 | 0x3299
        | 0x1F000..=0x1FAFF)
}

fn texture(context: &egui::Context, character: char) -> Option<TextureHandle> {
    let font = font()?;
    let mut textures = font.textures.lock().ok()?;
    textures
        .entry(character)
        .or_insert_with(|| {
            let face = Face::parse(font.data, 0).ok()?;
            let glyph = face.glyph_index(character)?;
            if !face.is_color_glyph(glyph) {
                return None;
            }
            let image = rasterize(&face, glyph, RASTER)?;
            Some(context.load_texture(
                format!("emoji-{:x}", character as u32),
                image,
                TextureOptions::LINEAR,
            ))
        })
        .clone()
}

fn rasterize(face: &Face<'_>, glyph: GlyphId, size: u32) -> Option<ColorImage> {
    let units = face.units_per_em() as f32;
    let ascender = face.ascender() as f32;
    let descender = face.descender() as f32;
    let height = (ascender - descender).max(units);
    let scale = size as f32 / height;
    let advance = face.glyph_hor_advance(glyph).unwrap_or(units as u16) as f32;
    let base = Transform::from_row(
        scale,
        0.0,
        0.0,
        -scale,
        (size as f32 - advance * scale) / 2.0,
        ascender * scale + (size as f32 - (ascender - descender) * scale) / 2.0,
    );
    let mut painter = Rasterizer {
        face,
        size,
        path: None,
        transforms: vec![base],
        clips: vec![None],
        layers: vec![(Pixmap::new(size, size)?, CompositeMode::SourceOver)],
    };
    face.paint_color_glyph(glyph, 0, RgbaColor::new(255, 255, 255, 255), &mut painter)?;
    let pixmap = painter.layers.pop()?.0;
    let pixels: Vec<u8> = pixmap
        .pixels()
        .iter()
        .flat_map(|pixel| {
            let color = pixel.demultiply();
            [color.red(), color.green(), color.blue(), color.alpha()]
        })
        .collect();
    Some(ColorImage::from_rgba_unmultiplied(
        [size as usize, size as usize],
        &pixels,
    ))
}

struct PathSink(PathBuilder);

impl OutlineBuilder for PathSink {
    fn move_to(&mut self, x: f32, y: f32) {
        self.0.move_to(x, y);
    }
    fn line_to(&mut self, x: f32, y: f32) {
        self.0.line_to(x, y);
    }
    fn quad_to(&mut self, x1: f32, y1: f32, x: f32, y: f32) {
        self.0.quad_to(x1, y1, x, y);
    }
    fn curve_to(&mut self, x1: f32, y1: f32, x2: f32, y2: f32, x: f32, y: f32) {
        self.0.cubic_to(x1, y1, x2, y2, x, y);
    }
    fn close(&mut self) {
        self.0.close();
    }
}

/// Implements the COLR paint graph (v0 layers and v1 gradients, transforms,
/// clips and composite layers) on tiny-skia.
struct Rasterizer<'a, 'f> {
    face: &'f Face<'a>,
    size: u32,
    path: Option<tiny_skia::Path>,
    transforms: Vec<Transform>,
    clips: Vec<Option<Mask>>,
    layers: Vec<(Pixmap, CompositeMode)>,
}

fn color(color: RgbaColor) -> tiny_skia::Color {
    tiny_skia::Color::from_rgba8(color.red, color.green, color.blue, color.alpha)
}

fn stops(colors: impl Iterator<Item = ttf_parser::colr::ColorStop>) -> Vec<GradientStop> {
    colors
        .map(|stop| GradientStop::new(stop.stop_offset.clamp(0.0, 1.0), color(stop.color)))
        .collect()
}

fn spread(extend: ttf_parser::colr::GradientExtend) -> SpreadMode {
    match extend {
        ttf_parser::colr::GradientExtend::Pad => SpreadMode::Pad,
        ttf_parser::colr::GradientExtend::Repeat => SpreadMode::Repeat,
        ttf_parser::colr::GradientExtend::Reflect => SpreadMode::Reflect,
    }
}

fn blend(mode: CompositeMode) -> BlendMode {
    match mode {
        CompositeMode::Clear => BlendMode::Clear,
        CompositeMode::Source => BlendMode::Source,
        CompositeMode::Destination => BlendMode::Destination,
        CompositeMode::DestinationOver => BlendMode::DestinationOver,
        CompositeMode::SourceIn => BlendMode::SourceIn,
        CompositeMode::DestinationIn => BlendMode::DestinationIn,
        CompositeMode::SourceOut => BlendMode::SourceOut,
        CompositeMode::DestinationOut => BlendMode::DestinationOut,
        CompositeMode::SourceAtop => BlendMode::SourceAtop,
        CompositeMode::DestinationAtop => BlendMode::DestinationAtop,
        CompositeMode::Xor => BlendMode::Xor,
        CompositeMode::Plus => BlendMode::Plus,
        CompositeMode::Screen => BlendMode::Screen,
        CompositeMode::Overlay => BlendMode::Overlay,
        CompositeMode::Darken => BlendMode::Darken,
        CompositeMode::Lighten => BlendMode::Lighten,
        CompositeMode::ColorDodge => BlendMode::ColorDodge,
        CompositeMode::ColorBurn => BlendMode::ColorBurn,
        CompositeMode::HardLight => BlendMode::HardLight,
        CompositeMode::SoftLight => BlendMode::SoftLight,
        CompositeMode::Difference => BlendMode::Difference,
        CompositeMode::Exclusion => BlendMode::Exclusion,
        CompositeMode::Multiply => BlendMode::Multiply,
        CompositeMode::Hue => BlendMode::Hue,
        CompositeMode::Saturation => BlendMode::Saturation,
        CompositeMode::Color => BlendMode::Color,
        CompositeMode::Luminosity => BlendMode::Luminosity,
        _ => BlendMode::SourceOver,
    }
}

impl Rasterizer<'_, '_> {
    fn transform(&self) -> Transform {
        *self.transforms.last().unwrap_or(&Transform::identity())
    }

    fn clip(&self) -> Option<&Mask> {
        self.clips.last().and_then(Option::as_ref)
    }

    fn push_mask(&mut self, path: &tiny_skia::Path) {
        let transform = self.transform();
        let mask = match self.clip() {
            Some(previous) => {
                let mut mask = previous.clone();
                mask.intersect_path(path, FillRule::Winding, true, transform);
                Some(mask)
            }
            None => Mask::new(self.size, self.size).map(|mut mask| {
                mask.fill_path(path, FillRule::Winding, true, transform);
                mask
            }),
        };
        self.clips.push(mask);
    }

    fn fill(&mut self, shader: Shader<'_>) {
        let paint = Paint {
            shader,
            anti_alias: true,
            ..Paint::default()
        };
        let Some(rect) = tiny_skia::Rect::from_xywh(0.0, 0.0, self.size as f32, self.size as f32)
        else {
            return;
        };
        let mask = self.clips.last().cloned().flatten();
        if let Some((pixmap, _)) = self.layers.last_mut() {
            pixmap.fill_rect(rect, &paint, Transform::identity(), mask.as_ref());
        }
    }
}

impl<'a> ColrPainter<'a> for Rasterizer<'a, '_> {
    fn outline_glyph(&mut self, glyph_id: GlyphId) {
        let mut sink = PathSink(PathBuilder::new());
        self.path = self
            .face
            .outline_glyph(glyph_id, &mut sink)
            .and_then(|_| sink.0.finish());
    }

    fn paint(&mut self, paint: ColrPaint<'a>) {
        let transform = self.transform();
        let shader = match paint {
            ColrPaint::Solid(solid) => Some(Shader::SolidColor(color(solid))),
            ColrPaint::LinearGradient(gradient) => LinearGradient::new(
                Point::from_xy(gradient.x0, gradient.y0),
                Point::from_xy(gradient.x1, gradient.y1),
                stops(gradient.stops(0, &[])),
                spread(gradient.extend),
                transform,
            ),
            ColrPaint::RadialGradient(gradient) => RadialGradient::new(
                Point::from_xy(gradient.x0, gradient.y0),
                Point::from_xy(gradient.x1, gradient.y1),
                gradient.r1,
                stops(gradient.stops(0, &[])),
                spread(gradient.extend),
                transform,
            ),
            // tiny-skia has no sweep gradient; approximate with the mean colour.
            ColrPaint::SweepGradient(gradient) => {
                let colors: Vec<_> = gradient.stops(0, &[]).map(|stop| stop.color).collect();
                let count = colors.len().max(1) as u32;
                let sum = colors.iter().fold([0u32; 4], |sum, c| {
                    [
                        sum[0] + c.red as u32,
                        sum[1] + c.green as u32,
                        sum[2] + c.blue as u32,
                        sum[3] + c.alpha as u32,
                    ]
                });
                Some(Shader::SolidColor(tiny_skia::Color::from_rgba8(
                    (sum[0] / count) as u8,
                    (sum[1] / count) as u8,
                    (sum[2] / count) as u8,
                    (sum[3] / count) as u8,
                )))
            }
        };
        if let Some(shader) = shader {
            self.fill(shader);
        }
    }

    fn push_clip(&mut self) {
        match self.path.take() {
            Some(path) => self.push_mask(&path),
            None => self.clips.push(Mask::new(self.size, self.size)),
        }
    }

    fn push_clip_box(&mut self, clipbox: ClipBox) {
        let path =
            tiny_skia::Rect::from_ltrb(clipbox.x_min, clipbox.y_min, clipbox.x_max, clipbox.y_max)
                .map(PathBuilder::from_rect);
        match path {
            Some(path) => self.push_mask(&path),
            None => self.clips.push(self.clip().cloned()),
        }
    }

    fn pop_clip(&mut self) {
        if self.clips.len() > 1 {
            self.clips.pop();
        }
    }

    fn push_layer(&mut self, mode: CompositeMode) {
        if let Some(pixmap) = Pixmap::new(self.size, self.size) {
            self.layers.push((pixmap, mode));
        }
    }

    fn pop_layer(&mut self) {
        if self.layers.len() < 2 {
            return;
        }
        let Some((layer, mode)) = self.layers.pop() else {
            return;
        };
        if let Some((parent, _)) = self.layers.last_mut() {
            parent.draw_pixmap(
                0,
                0,
                layer.as_ref(),
                &PixmapPaint {
                    blend_mode: blend(mode),
                    ..PixmapPaint::default()
                },
                Transform::identity(),
                None,
            );
        }
    }

    fn push_transform(&mut self, transform: ttf_parser::Transform) {
        let next = self.transform().pre_concat(Transform::from_row(
            transform.a,
            transform.b,
            transform.c,
            transform.d,
            transform.e,
            transform.f,
        ));
        self.transforms.push(next);
    }

    fn pop_transform(&mut self) {
        if self.transforms.len() > 1 {
            self.transforms.pop();
        }
    }
}

/// Paint `galley` like `Painter::galley_with_override_text_color`, drawing any
/// colour emoji in full colour. Emoji fade with the text colour's alpha.
pub fn paint_galley(painter: &Painter, pos: Pos2, galley: Arc<Galley>, color: Color32) {
    if !galley.job.text.chars().any(maybe_emoji) {
        painter.galley_with_override_text_color(pos, galley, color);
        return;
    }
    let context = painter.ctx().clone();
    let mut emoji = Vec::new();
    let mut hidden = (*galley).clone();
    for placed in &mut hidden.rows {
        let row_pos = placed.pos;
        let row_mid = placed.rect().center().y;
        let row = Arc::make_mut(&mut placed.row);
        let vertex_count = row.visuals.mesh.vertices.len() as u32;
        let starts: Vec<u32> = row.glyphs.iter().map(|glyph| glyph.first_vertex).collect();
        for (index, glyph) in row.glyphs.iter().enumerate() {
            if !maybe_emoji(glyph.chr) {
                continue;
            }
            let Some(texture) = texture(&context, glyph.chr) else {
                continue;
            };
            let side = glyph.advance_width.min(glyph.font_height * 1.05);
            let center = Pos2::new(
                pos.x + row_pos.x + glyph.pos.x + glyph.advance_width / 2.0,
                pos.y + row_mid,
            );
            emoji.push((texture, Rect::from_center_size(center, Vec2::splat(side))));
            // Collapse the monochrome glyph's quad so it does not show.
            let end = starts
                .get(index + 1)
                .copied()
                .unwrap_or(vertex_count)
                .min(vertex_count);
            for vertex in &mut row.visuals.mesh.vertices[glyph.first_vertex as usize..end as usize]
            {
                vertex.pos = Pos2::ZERO;
            }
        }
    }
    painter.galley_with_override_text_color(pos, Arc::new(hidden), color);
    let tint = Color32::from_white_alpha(color.a());
    for (texture, rect) in emoji {
        painter.image(
            texture.id(),
            rect,
            Rect::from_min_max(Pos2::ZERO, Pos2::new(1.0, 1.0)),
            tint,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn emoji_prefilter_skips_plain_text() {
        assert!(maybe_emoji('🐒'));
        assert!(maybe_emoji('❤'));
        assert!(!"GO SHIT".chars().any(maybe_emoji));
        assert!(!"夜に駆ける".chars().any(maybe_emoji));
    }

    #[test]
    fn system_emoji_rasterizes_in_colour() {
        let Some(font) = font() else {
            return;
        };
        let face = Face::parse(font.data, 0).unwrap();
        let glyph = face.glyph_index('🐒').unwrap();
        let image = rasterize(&face, glyph, 32).unwrap();
        let coloured = image
            .pixels
            .iter()
            .filter(|pixel| pixel.a() > 0 && (pixel.r() != pixel.g() || pixel.g() != pixel.b()))
            .count();
        assert!(coloured > 50, "expected coloured pixels, got {coloured}");
    }
}
