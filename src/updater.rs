use std::{
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};

use anyhow::{Context, Result, ensure};
use base64::{Engine, engine::general_purpose::STANDARD};
use ed25519_dalek::{Signature, VerifyingKey};
use eframe::egui;
use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::config::data_dir;

pub const BASE_URL: &str = "https://updates.clypdat.xyz";
pub const TARGET: &str = "windows-x86_64";
pub const PUBLIC_KEY: &str = include_str!("../config/update-public-key.base64");
const MAX_ARTIFACT: u64 = 512 * 1024 * 1024;

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    pub version: String,
    pub target: String,
    pub artifact: String,
    pub sha256: String,
    pub size: u64,
    pub notes: String,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Envelope {
    pub payload: String,
    pub signature: String,
}

#[derive(Clone)]
pub struct Update {
    pub manifest: Manifest,
    envelope: Vec<u8>,
}

pub struct ReadyUpdate {
    pub version: String,
    path: PathBuf,
    envelope: Vec<u8>,
}

pub enum Command {
    Check,
    Download(Update),
    Install(ReadyUpdate),
    Shutdown,
}
pub enum Event {
    Current,
    Available(Update),
    Progress { downloaded: u64, total: u64 },
    Ready(ReadyUpdate),
    Restarted,
    Error(String),
}

pub struct Updater {
    pub commands: mpsc::Sender<Command>,
    pub events: mpsc::Receiver<Event>,
}

fn public_key(encoded: &str) -> Result<VerifyingKey> {
    let bytes: [u8; 32] = STANDARD
        .decode(encoded.trim())
        .context("Update signing key is not configured")?
        .try_into()
        .map_err(|_| anyhow::anyhow!("Invalid update signing key"))?;
    Ok(VerifyingKey::from_bytes(&bytes)?)
}

fn verify(envelope: &[u8], key: &VerifyingKey) -> Result<Manifest> {
    ensure!(envelope.len() <= 65_536, "Update manifest exceeds limit");
    let envelope: Envelope = serde_json::from_slice(envelope).context("Invalid update envelope")?;
    let payload = STANDARD
        .decode(envelope.payload)
        .context("Invalid update payload")?;
    let signature = Signature::from_slice(&STANDARD.decode(envelope.signature)?)
        .context("Invalid update signature")?;
    key.verify_strict(&payload, &signature)
        .context("Update signature verification failed")?;
    let manifest: Manifest =
        serde_json::from_slice(&payload).context("Invalid signed update manifest")?;
    let version = Version::parse(&manifest.version)?;
    ensure!(
        version.pre.is_empty() && version.build.is_empty(),
        "Stable update has an invalid version"
    );
    ensure!(
        manifest.target == TARGET,
        "Update targets a different platform"
    );
    ensure!(
        manifest.artifact == format!("releases/{}/{TARGET}/spotiflex.exe", manifest.version),
        "Invalid update artifact path"
    );
    ensure!(
        manifest.size > 0 && manifest.size <= MAX_ARTIFACT,
        "Update artifact size is invalid"
    );
    ensure!(
        manifest.sha256.len() == 64 && manifest.sha256.bytes().all(|byte| byte.is_ascii_hexdigit()),
        "Invalid update checksum"
    );
    ensure!(
        manifest.notes.len() <= 16_384,
        "Update release notes exceed limit"
    );
    Ok(manifest)
}

fn client() -> Result<reqwest::blocking::Client> {
    Ok(reqwest::blocking::Client::builder()
        .user_agent(concat!("SpotiFlex/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(300))
        .redirect(reqwest::redirect::Policy::none())
        .build()?)
}

fn check(client: &reqwest::blocking::Client) -> Result<Option<Update>> {
    let response = client
        .get(format!("{BASE_URL}/channels/stable/{TARGET}.json"))
        .timeout(Duration::from_secs(15))
        .send()
        .map_err(|_| anyhow::anyhow!("Cannot reach update service"))?;
    // No channel is published until the first signed release is uploaded.
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    ensure!(
        response.status().is_success(),
        "Update service returned HTTP {}",
        response.status().as_u16()
    );
    let mut envelope = Vec::new();
    response.take(65_537).read_to_end(&mut envelope)?;
    let manifest = verify(&envelope, &public_key(PUBLIC_KEY)?)?;
    if Version::parse(&manifest.version)? <= Version::parse(env!("CARGO_PKG_VERSION"))? {
        return Ok(None);
    }
    Ok(Some(Update { manifest, envelope }))
}

pub fn file_hash(path: &Path) -> Result<String> {
    let mut file = File::open(path)?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 65_536];
    loop {
        let size = file.read(&mut buffer)?;
        if size == 0 {
            break;
        }
        hash.update(&buffer[..size]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

fn verify_file(path: &Path, manifest: &Manifest) -> Result<()> {
    ensure!(
        fs::metadata(path)?.len() == manifest.size,
        "Update download size mismatch"
    );
    ensure!(
        file_hash(path)?.eq_ignore_ascii_case(&manifest.sha256),
        "Update download checksum mismatch"
    );
    Ok(())
}

fn download(
    client: &reqwest::blocking::Client,
    update: &Update,
    mut progress: impl FnMut(u64, u64),
) -> Result<ReadyUpdate> {
    let manifest = verify(&update.envelope, &public_key(PUBLIC_KEY)?)?;
    ensure!(
        Version::parse(&manifest.version)? > Version::parse(env!("CARGO_PKG_VERSION"))?,
        "Refusing to install an older version"
    );
    let directory = data_dir()?.join("updates");
    fs::create_dir_all(&directory)?;
    let path = directory.join(format!(
        "spotiflex-{}-{}.exe",
        manifest.version,
        &manifest.sha256[..16]
    ));
    if path.exists() && verify_file(&path, &manifest).is_ok() {
        return Ok(ReadyUpdate {
            version: manifest.version,
            path,
            envelope: update.envelope.clone(),
        });
    }
    let partial = path.with_extension("download");
    let result = (|| -> Result<()> {
        let mut response = client
            .get(format!("{BASE_URL}/{}", manifest.artifact))
            .send()
            .map_err(|_| anyhow::anyhow!("Cannot download update"))?;
        ensure!(
            response.status().is_success(),
            "Update download returned HTTP {}",
            response.status().as_u16()
        );
        if let Some(size) = response.content_length() {
            ensure!(size == manifest.size, "Update download size mismatch");
        }
        let mut file = File::create(&partial)?;
        let mut buffer = [0u8; 65_536];
        let mut downloaded = 0;
        let mut last_progress = Instant::now();
        loop {
            let size = response.read(&mut buffer)?;
            if size == 0 {
                break;
            }
            downloaded += size as u64;
            ensure!(
                downloaded <= manifest.size,
                "Update exceeded signed size limit"
            );
            file.write_all(&buffer[..size])?;
            if last_progress.elapsed() >= Duration::from_millis(200) {
                progress(downloaded, manifest.size);
                last_progress = Instant::now();
            }
        }
        file.sync_all()?;
        drop(file);
        verify_file(&partial, &manifest)?;
        fs::rename(&partial, &path)?;
        progress(manifest.size, manifest.size);
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&partial);
    }
    result?;
    Ok(ReadyUpdate {
        version: manifest.version,
        path,
        envelope: update.envelope.clone(),
    })
}

fn install(update: ReadyUpdate) -> Result<()> {
    ensure!(
        cfg!(all(target_os = "windows", target_arch = "x86_64")),
        "Automatic installation currently supports Windows x86_64"
    );
    let manifest = verify(&update.envelope, &public_key(PUBLIC_KEY)?)?;
    ensure!(
        Version::parse(&manifest.version)? > Version::parse(env!("CARGO_PKG_VERSION"))?,
        "Refusing to install an older version"
    );
    verify_file(&update.path, &manifest)?;
    let executable = std::env::current_exe()?;
    fs::copy(
        &executable,
        data_dir()?.join("updates").join("previous-spotiflex.exe"),
    )
    .context("Cannot back up the current executable")?;
    self_replace::self_replace(&update.path)
        .context("Cannot install update. Run SpotiFlex from a folder your account can write to.")?;
    std::process::Command::new(executable)
        .spawn()
        .context("Update installed; restart SpotiFlex to finish")?;
    Ok(())
}

impl Updater {
    pub fn start(context: egui::Context) -> Self {
        let (commands, receiver) = mpsc::channel();
        let (sender, events) = mpsc::channel();
        thread::spawn(move || {
            let emit = |event| {
                let _ = sender.send(event);
                context.request_repaint();
            };
            let Ok(client) = client() else {
                emit(Event::Error("Cannot initialize update service".into()));
                return;
            };
            let mut next_check = Instant::now();
            loop {
                let command = match receiver.recv_timeout(Duration::from_millis(500)) {
                    Ok(command) => Some(command),
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    Err(mpsc::RecvTimeoutError::Timeout) if Instant::now() >= next_check => {
                        Some(Command::Check)
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => None,
                };
                let Some(command) = command else {
                    continue;
                };
                let result = match command {
                    Command::Shutdown => break,
                    Command::Check => {
                        next_check = Instant::now() + Duration::from_secs(30 * 60);
                        match check(&client) {
                            Ok(Some(update)) => {
                                emit(Event::Available(update));
                                Ok(())
                            }
                            Ok(None) => {
                                emit(Event::Current);
                                Ok(())
                            }
                            Err(error) => Err(error),
                        }
                    }
                    Command::Download(update) => {
                        match download(&client, &update, |downloaded, total| {
                            emit(Event::Progress { downloaded, total })
                        }) {
                            Ok(ready) => {
                                emit(Event::Ready(ready));
                                Ok(())
                            }
                            Err(error) => Err(error),
                        }
                    }
                    Command::Install(update) => match install(update) {
                        Ok(()) => {
                            emit(Event::Restarted);
                            break;
                        }
                        Err(error) => Err(error),
                    },
                };
                if let Err(error) = result {
                    emit(Event::Error(error.to_string()));
                }
            }
        });
        Self { commands, events }
    }
}

impl Drop for Updater {
    fn drop(&mut self) {
        let _ = self.commands.send(Command::Shutdown);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    fn signed(manifest: &Manifest) -> (Vec<u8>, VerifyingKey) {
        let key = SigningKey::from_bytes(&[7; 32]);
        let payload = serde_json::to_vec(manifest).unwrap();
        let signature = key.sign(&payload);
        (
            serde_json::to_vec(&Envelope {
                payload: STANDARD.encode(payload),
                signature: STANDARD.encode(signature.to_bytes()),
            })
            .unwrap(),
            key.verifying_key(),
        )
    }

    fn manifest() -> Manifest {
        Manifest {
            version: "0.2.0".into(),
            target: TARGET.into(),
            artifact: format!("releases/0.2.0/{TARGET}/spotiflex.exe"),
            sha256: "a".repeat(64),
            size: 10,
            notes: "Release notes".into(),
        }
    }

    #[test]
    fn signed_updates_reject_tampering_wrong_keys_and_foreign_paths() {
        let (bytes, key) = signed(&manifest());
        assert_eq!(verify(&bytes, &key).unwrap().version, "0.2.0");
        assert!(verify(&bytes, &SigningKey::from_bytes(&[8; 32]).verifying_key()).is_err());
        let mut envelope: Envelope = serde_json::from_slice(&bytes).unwrap();
        envelope.payload = STANDARD.encode(b"tampered");
        assert!(verify(&serde_json::to_vec(&envelope).unwrap(), &key).is_err());
        let mut bad = manifest();
        bad.artifact = "https://elsewhere.example.com/app.exe".into();
        let (bytes, key) = signed(&bad);
        assert!(verify(&bytes, &key).is_err());
    }

    #[test]
    fn signed_updates_reject_wrong_platform_and_excess_size() {
        let mut bad = manifest();
        bad.target = "other-platform".into();
        let (bytes, key) = signed(&bad);
        assert!(verify(&bytes, &key).is_err());
        bad = manifest();
        bad.size = MAX_ARTIFACT + 1;
        let (bytes, key) = signed(&bad);
        assert!(verify(&bytes, &key).is_err());
    }
}
