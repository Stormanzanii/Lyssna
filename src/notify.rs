use std::sync::Arc;

/// A wake-up signal independent of the windowing/rendering framework.
#[derive(Clone, Default)]
pub struct Notifier(Option<Arc<dyn Fn() + Send + Sync>>);

impl Notifier {
    pub fn new(callback: impl Fn() + Send + Sync + 'static) -> Self {
        Self(Some(Arc::new(callback)))
    }
    pub fn request_repaint(&self) {
        if let Some(callback) = &self.0 {
            callback();
        }
    }
}
