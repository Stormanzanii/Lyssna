//! Native media integration: Windows taskbar buttons and system media controls
//! on Windows and macOS, including media keys and the lock screen. Button presses are forwarded to the frontend,
//! which owns the playback intent; the frontend reports what is playing back.

use serde::Deserialize;

/// What the frontend reports about the current item.
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MediaState {
    pub title: String,
    pub artists: String,
    pub album: String,
    /// HTTPS artwork URL, or empty.
    pub cover: String,
    pub duration_ms: u64,
    pub position_ms: u64,
    pub playing: bool,
    /// False when nothing is loaded; the controls then show as disabled.
    pub loaded: bool,
}

#[cfg(any(target_os = "macos", test))]
impl MediaState {
    fn same_metadata(&self, other: &Self) -> bool {
        self.loaded == other.loaded
            && self.title == other.title
            && self.artists == other.artists
            && self.album == other.album
            && self.cover == other.cover
            && self.duration_ms == other.duration_ms
    }
}

/// A press from the taskbar, media keys or the media flyout.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MediaAction {
    Toggle,
    Play,
    Pause,
    Next,
    Previous,
    Seek(u64),
}

impl MediaAction {
    pub fn name(self) -> &'static str {
        match self {
            Self::Toggle => "toggle",
            Self::Play => "play",
            Self::Pause => "pause",
            Self::Next => "next",
            Self::Previous => "previous",
            Self::Seek(_) => "seek",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Glyph {
    Previous,
    Play,
    Pause,
    Next,
}

/// White glyph on transparency as premultiplied BGRA rows, top to bottom.
/// Edges are supersampled so the icons stay smooth at small sizes.
pub fn glyph(kind: Glyph, size: usize) -> Vec<u8> {
    const SAMPLES: usize = 4;
    let unit = size as f32;
    let inside = |x: f32, y: f32| -> bool {
        let (x, y) = (x / unit, y / unit);
        // Triangle pointing right with its tip at `tip` and its base at `base`.
        let right = |base: f32, tip: f32| {
            let t = (x - base) / (tip - base);
            (0.0..=1.0).contains(&t) && (y - 0.5).abs() <= 0.32 * (1.0 - t)
        };
        let left = |base: f32, tip: f32| {
            let t = (base - x) / (base - tip);
            (0.0..=1.0).contains(&t) && (y - 0.5).abs() <= 0.32 * (1.0 - t)
        };
        let bar = |from: f32, to: f32| (from..=to).contains(&x) && (0.18..=0.82).contains(&y);
        match kind {
            Glyph::Play => right(0.24, 0.82),
            Glyph::Pause => bar(0.24, 0.42) || bar(0.58, 0.76),
            Glyph::Next => right(0.2, 0.68) || bar(0.68, 0.8),
            Glyph::Previous => left(0.8, 0.32) || bar(0.2, 0.32),
        }
    };
    let mut pixels = Vec::with_capacity(size * size * 4);
    for row in 0..size {
        for column in 0..size {
            let mut hits = 0;
            for sy in 0..SAMPLES {
                for sx in 0..SAMPLES {
                    let x = column as f32 + (sx as f32 + 0.5) / SAMPLES as f32;
                    let y = row as f32 + (sy as f32 + 0.5) / SAMPLES as f32;
                    hits += usize::from(inside(x, y));
                }
            }
            let alpha = (hits * 255 / (SAMPLES * SAMPLES)) as u8;
            pixels.extend_from_slice(&[alpha, alpha, alpha, alpha]);
        }
    }
    pixels
}

#[cfg(windows)]
pub use windows_impl::Session;

#[cfg(target_os = "macos")]
pub use macos_impl::Session;

#[cfg(not(any(windows, target_os = "macos")))]
pub struct Session;
#[cfg(not(any(windows, target_os = "macos")))]
impl Session {
    pub fn start(
        _app: &tauri::AppHandle,
        _on_action: impl Fn(MediaAction) + Send + Sync + 'static,
    ) -> Self {
        Self
    }
    pub fn update(&self, _app: &tauri::AppHandle, _state: MediaState) {}
}

#[cfg(target_os = "macos")]
mod macos_impl {
    use super::{MediaAction, MediaState};
    use souvlaki::{
        MediaControlEvent, MediaControls, MediaMetadata, MediaPlayback, MediaPosition,
        PlatformConfig, SeekDirection,
    };
    use std::{cell::RefCell, time::Duration};

    // AppKit media objects must stay on the application's main thread.
    thread_local! {
        static CONTROLS: RefCell<Option<Controls>> = const { RefCell::new(None) };
    }

    struct Controls {
        native: MediaControls,
        metadata: Option<MediaState>,
    }

    pub struct Session;
    impl Session {
        pub fn start(
            _app: &tauri::AppHandle,
            on_action: impl Fn(MediaAction) + Send + Sync + 'static,
        ) -> Self {
            let config = PlatformConfig {
                dbus_name: "lyssna",
                display_name: "Lyssna",
                hwnd: None,
            };
            if let Ok(mut controls) = MediaControls::new(config) {
                let attached = controls.attach(move |event| {
                    let action = match event {
                        MediaControlEvent::Toggle => MediaAction::Toggle,
                        MediaControlEvent::Play => MediaAction::Play,
                        MediaControlEvent::Pause | MediaControlEvent::Stop => MediaAction::Pause,
                        MediaControlEvent::Next
                        | MediaControlEvent::Seek(SeekDirection::Forward) => MediaAction::Next,
                        MediaControlEvent::Previous
                        | MediaControlEvent::Seek(SeekDirection::Backward) => MediaAction::Previous,
                        MediaControlEvent::SetPosition(MediaPosition(position)) => {
                            MediaAction::Seek(position.as_millis() as u64)
                        }
                        _ => return,
                    };
                    on_action(action);
                });
                if attached.is_ok() {
                    CONTROLS.with_borrow_mut(|slot| {
                        *slot = Some(Controls {
                            native: controls,
                            metadata: None,
                        });
                    });
                }
            }
            Self
        }

        pub fn update(&self, app: &tauri::AppHandle, state: MediaState) {
            let _ = app.run_on_main_thread(move || {
                CONTROLS.with_borrow_mut(|slot| {
                    let Some(controls) = slot else { return };
                    let progress = Some(MediaPosition(Duration::from_millis(state.position_ms)));
                    let playback = if !state.loaded {
                        MediaPlayback::Stopped
                    } else if state.playing {
                        MediaPlayback::Playing { progress }
                    } else {
                        MediaPlayback::Paused { progress }
                    };
                    // Souvlaki downloads artwork whenever metadata is set. Clock
                    // and pause updates must not start another artwork request.
                    if controls
                        .metadata
                        .as_ref()
                        .is_none_or(|last| !last.same_metadata(&state))
                    {
                        let result = controls.native.set_metadata(MediaMetadata {
                            title: Some(state.title.as_str())
                                .filter(|text| state.loaded && !text.is_empty()),
                            artist: Some(state.artists.as_str())
                                .filter(|text| state.loaded && !text.is_empty()),
                            album: Some(state.album.as_str())
                                .filter(|text| state.loaded && !text.is_empty()),
                            cover_url: (state.loaded && state.cover.starts_with("https://"))
                                .then_some(state.cover.as_str()),
                            duration: (state.loaded && state.duration_ms > 0)
                                .then(|| Duration::from_millis(state.duration_ms)),
                        });
                        if result.is_ok() {
                            controls.metadata = Some(state);
                        }
                    }
                    let _ = controls.native.set_playback(playback);
                });
            });
        }
    }
}

#[cfg(windows)]
mod windows_impl {
    use super::{Glyph, MediaAction, MediaState, glyph};
    use souvlaki::{
        MediaControlEvent, MediaControls, MediaMetadata, MediaPlayback, MediaPosition,
        PlatformConfig, SeekDirection,
    };
    use std::cell::RefCell;
    use std::sync::{Arc, OnceLock};
    use std::time::Duration;
    use tauri::Manager;
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::Graphics::Gdi::{CreateBitmap, DeleteObject};
    use windows::Win32::System::Com::{CLSCTX_INPROC_SERVER, CoCreateInstance};
    use windows::Win32::UI::Shell::{
        DefSubclassProc, ITaskbarList3, SetWindowSubclass, THB_FLAGS, THB_ICON, THB_TOOLTIP,
        THBF_DISABLED, THBF_ENABLED, THUMBBUTTON, TaskbarList,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateIconIndirect, DestroyIcon, GetSystemMetrics, HICON, ICON_BIG, ICONINFO,
        RegisterWindowMessageW, SM_CXSMICON, SendMessageW, WM_COMMAND, WM_SETICON,
    };
    use windows::core::w;

    const THBN_CLICKED: usize = 0x1800;
    const BUTTONS: [(u32, Glyph, &str); 3] = [
        (0, Glyph::Previous, "Previous"),
        (1, Glyph::Play, "Play"),
        (2, Glyph::Next, "Next"),
    ];

    type Handler = Arc<dyn Fn(MediaAction) + Send + Sync>;
    static HANDLER: OnceLock<Handler> = OnceLock::new();

    /// Taskbar and media-session objects. They belong to the window's thread,
    /// so every use runs on the main thread.
    struct Taskbar {
        hwnd: HWND,
        list: Option<ITaskbarList3>,
        added: bool,
        icons: [HICON; 4],
        app_icon: HICON,
        state: MediaState,
    }
    /// Windows' "TaskbarButtonCreated" message ID, read without borrowing state.
    static CREATED_MESSAGE: OnceLock<u32> = OnceLock::new();
    thread_local! {
        static TASKBAR: RefCell<Option<Taskbar>> = const { RefCell::new(None) };
        static CONTROLS: RefCell<Option<MediaControls>> = const { RefCell::new(None) };
    }

    fn icon(kind: Glyph) -> HICON {
        let size = unsafe { GetSystemMetrics(SM_CXSMICON) }.clamp(16, 64) as usize;
        let pixels = glyph(kind, size);
        native_icon(size, &pixels)
    }

    fn app_icon() -> HICON {
        let mut pixels = crate::app_icon::icon_rgba(64);
        for pixel in pixels.as_chunks_mut::<4>().0 {
            let alpha = u16::from(pixel[3]);
            let red = pixel[0];
            pixel[0] = (u16::from(pixel[2]) * alpha / 255) as u8;
            pixel[1] = (u16::from(pixel[1]) * alpha / 255) as u8;
            pixel[2] = (u16::from(red) * alpha / 255) as u8;
        }
        native_icon(64, &pixels)
    }

    fn native_icon(size: usize, pixels: &[u8]) -> HICON {
        let stride = size.div_ceil(16) * 2;
        let mut mask = vec![0; stride * size];
        for y in 0..size {
            for x in 0..size {
                if pixels[(y * size + x) * 4 + 3] == 0 {
                    mask[y * stride + x / 8] |= 0x80 >> (x % 8);
                }
            }
        }
        unsafe {
            let color = CreateBitmap(
                size as i32,
                size as i32,
                1,
                32,
                Some(pixels.as_ptr().cast()),
            );
            let mask = CreateBitmap(size as i32, size as i32, 1, 1, Some(mask.as_ptr().cast()));
            let info = ICONINFO {
                fIcon: true.into(),
                hbmMask: mask,
                hbmColor: color,
                ..Default::default()
            };
            let icon = CreateIconIndirect(&info).unwrap_or_default();
            let _ = DeleteObject(color.into());
            let _ = DeleteObject(mask.into());
            icon
        }
    }

    impl Drop for Taskbar {
        fn drop(&mut self) {
            unsafe {
                for icon in self.icons.into_iter().chain([self.app_icon]) {
                    let _ = DestroyIcon(icon);
                }
            }
        }
    }

    fn tooltip(text: &str) -> [u16; 260] {
        let mut tip = [0u16; 260];
        for (slot, unit) in tip.iter_mut().zip(text.encode_utf16().take(259)) {
            *slot = unit;
        }
        tip
    }

    impl Taskbar {
        fn buttons(&self) -> [THUMBBUTTON; 3] {
            BUTTONS.map(|(id, kind, label)| {
                let (kind, label) = match (kind, self.state.playing) {
                    (Glyph::Play, true) => (Glyph::Pause, "Pause"),
                    _ => (kind, label),
                };
                let icon = self.icons[match kind {
                    Glyph::Previous => 0,
                    Glyph::Play => 1,
                    Glyph::Pause => 2,
                    Glyph::Next => 3,
                }];
                THUMBBUTTON {
                    dwMask: THB_ICON | THB_TOOLTIP | THB_FLAGS,
                    iId: id,
                    hIcon: icon,
                    szTip: tooltip(label),
                    dwFlags: if self.state.loaded {
                        THBF_ENABLED
                    } else {
                        THBF_DISABLED
                    },
                    ..Default::default()
                }
            })
        }
        /// Adds the buttons once the taskbar button exists, then keeps them
        /// in step with playback.
        fn sync(&mut self) {
            if self.list.is_none() {
                self.list = unsafe {
                    CoCreateInstance::<_, ITaskbarList3>(&TaskbarList, None, CLSCTX_INPROC_SERVER)
                }
                .ok()
                .filter(|list| unsafe { list.HrInit() }.is_ok());
            }
            let Some(list) = self.list.as_ref() else {
                return;
            };
            let buttons = self.buttons();
            unsafe {
                if self.added {
                    let _ = list.ThumbBarUpdateButtons(self.hwnd, &buttons);
                } else {
                    self.added = list.ThumbBarAddButtons(self.hwnd, &buttons).is_ok();
                }
            }
        }
    }

    unsafe extern "system" fn subclass(
        hwnd: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        _id: usize,
        _data: usize,
    ) -> LRESULT {
        if message == WM_COMMAND && (wparam.0 >> 16) & 0xffff == THBN_CLICKED {
            let action = match wparam.0 & 0xffff {
                0 => Some(MediaAction::Previous),
                1 => Some(MediaAction::Toggle),
                2 => Some(MediaAction::Next),
                _ => None,
            };
            if let (Some(action), Some(handler)) = (action, HANDLER.get()) {
                handler(action);
                return LRESULT(0);
            }
        }
        // Explorer restarts recreate the taskbar button without our buttons,
        // so add them again. Windows can call this procedure from inside
        // `sync` (the taskbar calls send window messages), so only borrow the
        // state for this one message and skip if it is already borrowed: a
        // panic here cannot unwind and would abort the app.
        if CREATED_MESSAGE.get() == Some(&message) {
            TASKBAR.with(|cell| {
                if let Ok(mut taskbar) = cell.try_borrow_mut()
                    && let Some(taskbar) = taskbar.as_mut()
                {
                    taskbar.list = None;
                    taskbar.added = false;
                    taskbar.sync();
                }
            });
        }
        unsafe { DefSubclassProc(hwnd, message, wparam, lparam) }
    }

    pub struct Session;

    impl Session {
        /// Call from the main thread after the main window exists.
        pub fn start(
            app: &tauri::AppHandle,
            on_action: impl Fn(MediaAction) + Send + Sync + 'static,
        ) -> Self {
            let handler: Handler = Arc::new(on_action);
            let _ = HANDLER.set(handler.clone());
            let Some(window) = app.get_webview_window("main") else {
                return Self;
            };
            let Ok(raw) = window.hwnd() else {
                return Self;
            };
            let hwnd = HWND(raw.0 as _);
            let app_icon = app_icon();
            unsafe {
                // Setting an icon sends window messages synchronously. Do this
                // before installing our subclass or borrowing its thread-local state.
                SendMessageW(
                    hwnd,
                    WM_SETICON,
                    Some(WPARAM(ICON_BIG as usize)),
                    Some(LPARAM(app_icon.0 as isize)),
                );
                let _ = SetWindowSubclass(hwnd, Some(subclass), 1, 0);
            }
            let _ =
                CREATED_MESSAGE.set(unsafe { RegisterWindowMessageW(w!("TaskbarButtonCreated")) });
            TASKBAR.with_borrow_mut(|taskbar| {
                let mut created = Taskbar {
                    hwnd,
                    list: None,
                    added: false,
                    icons: [Glyph::Previous, Glyph::Play, Glyph::Pause, Glyph::Next].map(icon),
                    app_icon,
                    state: MediaState::default(),
                };
                created.sync();
                *taskbar = Some(created);
            });
            let config = PlatformConfig {
                dbus_name: "lyssna",
                display_name: "Lyssna",
                hwnd: Some(hwnd.0),
            };
            if let Ok(mut controls) = MediaControls::new(config) {
                let attached = controls.attach(move |event| {
                    let action = match event {
                        MediaControlEvent::Toggle => MediaAction::Toggle,
                        MediaControlEvent::Play => MediaAction::Play,
                        MediaControlEvent::Pause | MediaControlEvent::Stop => MediaAction::Pause,
                        MediaControlEvent::Next
                        | MediaControlEvent::Seek(SeekDirection::Forward) => MediaAction::Next,
                        MediaControlEvent::Previous
                        | MediaControlEvent::Seek(SeekDirection::Backward) => MediaAction::Previous,
                        MediaControlEvent::SetPosition(MediaPosition(position)) => {
                            MediaAction::Seek(position.as_millis() as u64)
                        }
                        _ => return,
                    };
                    handler(action);
                });
                if attached.is_ok() {
                    CONTROLS.with_borrow_mut(|slot| *slot = Some(controls));
                }
            }
            Self
        }

        pub fn update(&self, app: &tauri::AppHandle, state: MediaState) {
            let _ = app.run_on_main_thread(move || {
                TASKBAR.with_borrow_mut(|taskbar| {
                    if let Some(taskbar) = taskbar
                        && taskbar.state != state
                    {
                        let buttons_changed = taskbar.state.playing != state.playing
                            || taskbar.state.loaded != state.loaded;
                        taskbar.state = state.clone();
                        if buttons_changed || !taskbar.added {
                            taskbar.sync();
                        }
                    }
                });
                CONTROLS.with_borrow_mut(|controls| {
                    let Some(controls) = controls else {
                        return;
                    };
                    let progress = Some(MediaPosition(Duration::from_millis(state.position_ms)));
                    let playback = if !state.loaded {
                        MediaPlayback::Stopped
                    } else if state.playing {
                        MediaPlayback::Playing { progress }
                    } else {
                        MediaPlayback::Paused { progress }
                    };
                    let cover = state
                        .cover
                        .starts_with("https://")
                        .then_some(state.cover.as_str());
                    let _ = controls.set_metadata(MediaMetadata {
                        title: Some(state.title.as_str()).filter(|title| !title.is_empty()),
                        artist: Some(state.artists.as_str()).filter(|text| !text.is_empty()),
                        album: Some(state.album.as_str()).filter(|text| !text.is_empty()),
                        cover_url: cover,
                        duration: (state.duration_ms > 0)
                            .then(|| Duration::from_millis(state.duration_ms)),
                    });
                    let _ = controls.set_playback(playback);
                });
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn alpha(pixels: &[u8], size: usize, x: usize, y: usize) -> u8 {
        pixels[(y * size + x) * 4 + 3]
    }

    #[test]
    fn glyphs_are_white_premultiplied_and_distinct() {
        let size = 16;
        let play = glyph(Glyph::Play, size);
        assert_eq!(play.len(), size * size * 4);
        for pixel in play.chunks(4) {
            assert!(pixel[..3].iter().all(|channel| *channel == pixel[3]));
        }
        // Play fills its centre; Pause leaves a gap between its bars.
        assert_eq!(alpha(&play, size, 8, 8), 255);
        let pause = glyph(Glyph::Pause, size);
        assert_eq!(alpha(&pause, size, 8, 8), 0);
        assert_eq!(alpha(&pause, size, 5, 8), 255);
        // Next and Previous mirror each other.
        let next = glyph(Glyph::Next, size);
        let previous = glyph(Glyph::Previous, size);
        for y in 0..size {
            for x in 0..size {
                let mirrored = alpha(&previous, size, size - 1 - x, y);
                assert!(alpha(&next, size, x, y).abs_diff(mirrored) <= 32);
            }
        }
        // Corners stay transparent.
        assert_eq!(alpha(&next, size, 0, 0), 0);
    }

    #[test]
    fn clock_and_pause_updates_reuse_artwork_but_track_changes_do_not() {
        let state = MediaState {
            loaded: true,
            title: "Song".into(),
            cover: "https://example.com/cover".into(),
            ..Default::default()
        };
        let mut next = state.clone();
        next.position_ms = 10_000;
        next.playing = true;
        assert!(state.same_metadata(&next));
        next.title = "Another song".into();
        assert!(!state.same_metadata(&next));
        next = state.clone();
        next.cover = "https://example.com/another-cover".into();
        assert!(!state.same_metadata(&next));
        next = state.clone();
        next.loaded = false;
        assert!(!state.same_metadata(&next));
    }

    #[test]
    fn media_state_rejects_unknown_fields() {
        let state: MediaState = serde_json::from_value(serde_json::json!({
            "title": "Song", "artists": "Artist", "album": "Album", "cover": "",
            "durationMs": 1000, "positionMs": 10, "playing": true, "loaded": true
        }))
        .unwrap();
        assert!(state.playing);
        assert!(
            serde_json::from_value::<MediaState>(serde_json::json!({
                "title": "", "artists": "", "album": "", "cover": "", "durationMs": 0,
                "positionMs": 0, "playing": false, "loaded": false, "token": "x"
            }))
            .is_err()
        );
    }
}
