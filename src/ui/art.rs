//! Artwork helpers: image size selection, accent colours, and blurred
//! textures for dynamic backgrounds. Decoding runs on worker threads.

use std::{
    collections::HashMap,
    sync::{Arc, mpsc},
};

use eframe::egui::{
    self, Color32, ColorImage, Painter, Pos2, Rect, Shape, TextureHandle, TextureOptions, Vec2,
    epaint::{Mesh, Vertex},
    load::{Bytes, BytesPoll},
};
use image::imageops::{self, FilterType};

use crate::model::Artwork;

const BLUR_SIDE: u32 = 72;

/// Choose the smallest image that still covers `pixels`, preferring known
/// sizes. Spotify lists album images largest first.
pub fn pick(images: &[Artwork], pixels: f32) -> Option<&str> {
    let usable: Vec<_> = images
        .iter()
        .filter(|image| image.url.starts_with("https://"))
        .collect();
    let sized = usable
        .iter()
        .filter_map(|image| image.width.map(|width| (width, image)));
    let fitting = sized
        .clone()
        .filter(|(width, _)| *width as f32 >= pixels)
        .min_by_key(|(width, _)| *width);
    fitting
        .or_else(|| sized.max_by_key(|(width, _)| *width))
        .map(|(_, image)| image.url.as_str())
        .or_else(|| usable.first().map(|image| image.url.as_str()))
}

pub struct Art {
    pub texture: TextureHandle,
    pub accent: Color32,
}

enum Entry {
    Fetching,
    Decoding,
    Ready(Art),
    Failed,
}

struct Decoded {
    url: String,
    result: Option<(ColorImage, [u8; 3])>,
}

pub struct ArtCache {
    entries: HashMap<String, Entry>,
    sender: mpsc::Sender<Decoded>,
    receiver: mpsc::Receiver<Decoded>,
}

impl Default for ArtCache {
    fn default() -> Self {
        let (sender, receiver) = mpsc::channel();
        Self {
            entries: HashMap::new(),
            sender,
            receiver,
        }
    }
}

impl ArtCache {
    pub fn poll(&mut self, context: &egui::Context) {
        while let Ok(decoded) = self.receiver.try_recv() {
            let entry = match decoded.result {
                Some((image, [r, g, b])) => Entry::Ready(Art {
                    texture: context.load_texture(
                        format!("blurred:{}", decoded.url),
                        image,
                        TextureOptions::LINEAR,
                    ),
                    accent: Color32::from_rgb(r, g, b),
                }),
                None => Entry::Failed,
            };
            self.entries.insert(decoded.url, entry);
        }
    }

    /// Blurred artwork for `url`, starting the download and decode when needed.
    pub fn get(&mut self, context: &egui::Context, url: &str) -> Option<&Art> {
        if !url.starts_with("https://") {
            return None;
        }
        match self.entries.get(url) {
            Some(Entry::Ready(_)) => {
                return match self.entries.get(url) {
                    Some(Entry::Ready(art)) => Some(art),
                    _ => None,
                };
            }
            Some(Entry::Decoding | Entry::Failed) => return None,
            Some(Entry::Fetching) | None => {}
        }
        let entry = match context.try_load_bytes(url) {
            Ok(BytesPoll::Ready { bytes, .. }) => {
                let data: Arc<[u8]> = match bytes {
                    Bytes::Shared(data) => data,
                    Bytes::Static(data) => data.into(),
                };
                let sender = self.sender.clone();
                let context = context.clone();
                let url = url.to_owned();
                std::thread::spawn(move || {
                    let result = process(&data);
                    let _ = sender.send(Decoded { url, result });
                    context.request_repaint();
                });
                Entry::Decoding
            }
            Ok(BytesPoll::Pending { .. }) => Entry::Fetching,
            Err(_) => Entry::Failed,
        };
        self.entries.insert(url.to_owned(), entry);
        None
    }

    pub fn accent(&mut self, context: &egui::Context, url: Option<&str>) -> Option<Color32> {
        url.and_then(|url| self.get(context, url))
            .map(|art| art.accent)
    }
}

fn process(bytes: &[u8]) -> Option<(ColorImage, [u8; 3])> {
    let image = image::load_from_memory(bytes).ok()?.to_rgb8();
    let small = imageops::resize(&image, 24, 24, FilterType::Triangle);
    let accent = accent(small.pixels().map(|pixel| pixel.0));
    let large = imageops::resize(&small, BLUR_SIDE, BLUR_SIDE, FilterType::CatmullRom);
    let blurred = imageops::blur(&large, 3.0);
    let half = BLUR_SIDE as f32 / 2.0;
    let mut rgba = Vec::with_capacity((BLUR_SIDE * BLUR_SIDE * 4) as usize);
    for (x, y, pixel) in blurred.enumerate_pixels() {
        let [r, g, b] = saturate(pixel.0, 2.5, 0.8);
        // Fade the edges so rotated layers blend without hard seams.
        let distance = Vec2::new(x as f32 + 0.5 - half, y as f32 + 0.5 - half).length() / half;
        let alpha = 1.0 - ((distance - 0.62) / 0.36).clamp(0.0, 1.0);
        let alpha = alpha * alpha * (3.0 - 2.0 * alpha);
        rgba.extend_from_slice(&[r, g, b, (alpha * 255.0) as u8]);
    }
    let image = ColorImage::from_rgba_unmultiplied([BLUR_SIDE as usize; 2], &rgba);
    Some((image, accent))
}

fn saturate([r, g, b]: [u8; 3], amount: f32, brightness: f32) -> [u8; 3] {
    let luma = 0.299 * r as f32 + 0.587 * g as f32 + 0.114 * b as f32;
    let channel =
        |value: u8| ((luma + (value as f32 - luma) * amount) * brightness).clamp(0.0, 255.0) as u8;
    [channel(r), channel(g), channel(b)]
}

/// Pick a vivid, mid-brightness colour representing the artwork. Grey artwork
/// stays grey instead of being tinted.
pub fn accent(pixels: impl Iterator<Item = [u8; 3]>) -> [u8; 3] {
    let mut best = (f32::MIN, 0.0, 0.0);
    let mut max_saturation: f32 = 0.0;
    for [r, g, b] in pixels {
        let hsva = egui::ecolor::Hsva::from_srgb([r, g, b]);
        max_saturation = max_saturation.max(hsva.s * hsva.v);
        let score = hsva.s * hsva.v * (1.0 - (hsva.v - 0.65).abs());
        if score > best.0 {
            best = (score, hsva.h, hsva.s);
        }
    }
    let saturation = if max_saturation < 0.12 {
        best.2.min(0.1)
    } else {
        best.2.clamp(0.45, 0.75)
    };
    egui::ecolor::Hsva::new(best.1, saturation, 0.52, 1.0).to_srgb()
}

/// Spicy-Lyrics-style animated background: three blurred, elliptical copies
/// of the artwork rotating on a 45 second period (their "Front", "Back" and
/// "BackCenter" layers), over the artwork's accent colour.
pub fn paint_background(painter: &Painter, rect: Rect, art: Option<&Art>, time: f32) {
    let Some(art) = art else {
        painter.rect_filled(rect, 0.0, Color32::from_rgb(28, 28, 32));
        return;
    };
    painter.rect_filled(
        rect,
        0.0,
        super::theme::lerp_color(art.accent, Color32::BLACK, 0.2),
    );
    let (width, height) = (rect.width(), rect.height());
    let angle = time * std::f32::consts::TAU / 45.0;
    // (centre relative to the top-left, half size, rotation direction), back to front.
    let layers = [
        (
            Vec2::new(0.0, 0.3 * height),
            Vec2::new(1.5 * width, 0.5 * height),
            -1.0,
        ),
        (
            Vec2::new(width, 0.5 * height),
            Vec2::new(width, 0.5 * height),
            -1.0,
        ),
        (
            Vec2::new(0.0, 0.5 * height),
            Vec2::new(width, 0.5 * height),
            1.0,
        ),
    ];
    for (offset, half, direction) in layers {
        // The textures fade at their edges, so oversize them to keep coverage.
        textured_quad(
            painter,
            &art.texture,
            rect.min + offset,
            half * 1.35,
            angle * direction,
            Color32::WHITE,
        );
    }
}

fn textured_quad(
    painter: &Painter,
    texture: &TextureHandle,
    center: Pos2,
    half: Vec2,
    angle: f32,
    tint: Color32,
) {
    let mut mesh = Mesh::with_texture(texture.id());
    let rotation = egui::emath::Rot2::from_angle(angle);
    for (x, y) in [(-1.0, -1.0), (1.0, -1.0), (1.0, 1.0), (-1.0, 1.0)] {
        mesh.vertices.push(Vertex {
            pos: center + rotation * Vec2::new(x * half.x, y * half.y),
            uv: Pos2::new((x + 1.0) / 2.0, (y + 1.0) / 2.0),
            color: tint,
        });
    }
    mesh.add_triangle(0, 1, 2);
    mesh.add_triangle(0, 2, 3);
    painter.add(Shape::mesh(mesh));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn artwork(url: &str, width: Option<u32>) -> Artwork {
        Artwork {
            url: url.into(),
            width,
        }
    }

    #[test]
    fn pick_prefers_smallest_covering_image() {
        let images = [
            artwork("https://a/640", Some(640)),
            artwork("https://a/300", Some(300)),
            artwork("https://a/64", Some(64)),
        ];
        assert_eq!(pick(&images, 48.0), Some("https://a/64"));
        assert_eq!(pick(&images, 120.0), Some("https://a/300"));
        assert_eq!(pick(&images, 900.0), Some("https://a/640"));
    }

    #[test]
    fn pick_skips_insecure_and_unsized_images() {
        let images = [
            artwork("http://a/1", Some(64)),
            artwork("https://a/2", None),
        ];
        assert_eq!(pick(&images, 48.0), Some("https://a/2"));
        assert_eq!(pick(&[], 48.0), None);
    }

    #[test]
    fn accent_follows_dominant_hue_and_keeps_grey_neutral() {
        let red = accent([[220, 30, 30], [20, 20, 20], [200, 200, 200]].into_iter());
        assert!(red[0] > red[1] && red[0] > red[2]);
        let grey = accent([[120, 120, 120], [40, 40, 40]].into_iter());
        let spread = grey.iter().max().unwrap() - grey.iter().min().unwrap();
        assert!(spread < 20);
    }
}
