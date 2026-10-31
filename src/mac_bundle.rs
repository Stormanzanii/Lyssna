//! Keeping the installed `Lyssna.app` in step with this executable on
//! macOS. Nightly and in-app updates replace only `Contents/MacOS/lyssna`,
//! so keys added to `Info.macos.plist` since the app was installed, such as
//! the `lyssna://` link type, would never reach the bundle. Each copy
//! carries the plist it was built with and merges it in at startup, then
//! signs the app again as the build script did and tells Launch Services.
use anyhow::{Context, Result, bail, ensure};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

const INFO: &str = include_str!("../Info.macos.plist");
const ENTITLEMENTS: &str = include_str!("../Entitlements.macos.plist");
const PLUTIL: &str = "/usr/bin/plutil";
const CODESIGN: &str = "/usr/bin/codesign";
const SECURITY: &str = "/usr/bin/security";
const LSREGISTER: &str = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

/// The `.app` this executable runs from, if any.
pub fn bundle() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()?
        .ancestors()
        .find(|path| path.extension().is_some_and(|extension| extension == "app"))
        .map(Path::to_path_buf)
}

/// The running app's bundle identifier, as its Info.plist names it.
pub fn identifier() -> Option<String> {
    let output = Command::new(PLUTIL)
        .args(["-extract", "CFBundleIdentifier", "raw", "-o", "-"])
        .arg(bundle()?.join("Contents/Info.plist"))
        .stderr(Stdio::null())
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

/// Bring the bundle's Info.plist up to date with this executable's, then
/// sign and register the app again if anything changed. Off the main
/// thread: signing takes a moment.
pub fn refresh() {
    std::thread::spawn(|| {
        if let Some(bundle) = bundle()
            && let Err(error) = refresh_bundle(&bundle, false)
        {
            log::warn!("Cannot update {}: {error:#}", bundle.display());
        }
    });
}

/// Lyssna was SpotiFlex. An app updated in place still runs from
/// `SpotiFlex.app`, and macOS names the menu bar, Dock and Finder entry from
/// the bundle as it was when the app started. Bring the bundle's Info.plist
/// up to date, move it to `Lyssna.app` and start it from there. True when
/// this copy should exit now.
pub fn relocate() -> bool {
    let Some(bundle) = bundle() else {
        return false;
    };
    if bundle
        .file_name()
        .is_none_or(|name| name != "SpotiFlex.app")
    {
        return false;
    }
    let target = bundle.with_file_name("Lyssna.app");
    // A Lyssna installed by the build script is already there: keep it.
    if target.exists() {
        return false;
    }
    if let Err(error) = refresh_bundle(&bundle, false) {
        log::warn!("Cannot update {}: {error:#}", bundle.display());
        return false;
    }
    if fs::rename(&bundle, &target).is_err() {
        return false;
    }
    let started = Command::new("/usr/bin/open")
        .arg("-n")
        .arg(&target)
        .arg("--args")
        .arg(crate::updater::AFTER_EXIT_ARG)
        .arg(std::process::id().to_string())
        .args(std::env::args().skip(1).filter(|argument| {
            // The previous copy's own wait is already over.
            argument != crate::updater::AFTER_EXIT_ARG && argument.parse::<u32>().is_err()
        }))
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success());
    if !started {
        let _ = fs::rename(&target, &bundle);
        return false;
    }
    for (flag, path) in [("-u", &bundle), ("-f", &target)] {
        let _ = Command::new(LSREGISTER)
            .arg(flag)
            .arg(path)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    true
}

/// After an executable was swapped in: merge, sign and register even if the
/// plist already matched, since the old signature no longer covers it.
pub fn after_replace(bundle: &Path) -> Result<()> {
    refresh_bundle(bundle, true)
}

fn refresh_bundle(bundle: &Path, replaced: bool) -> Result<()> {
    let info = bundle.join("Contents/Info.plist");
    ensure!(info.is_file(), "the app has no Info.plist");
    let work = tempfile_dir()?;
    let wanted = work.join("Info.macos.plist");
    fs::write(&wanted, INFO)?;
    let keys = top_level_keys(&wanted)?;
    let mut changed = Vec::new();
    for key in &keys {
        let value = extract(&wanted, key)?;
        if extract(&info, key).ok() != Some(value.clone()) {
            changed.push((key.clone(), value));
        }
    }
    if changed.is_empty() && !replaced {
        let _ = fs::remove_dir_all(&work);
        return Ok(());
    }
    let original = fs::read(&info)?;
    for (key, value) in &changed {
        let status = Command::new(PLUTIL)
            .args(["-replace", key, "-json", &value.to_string()])
            .arg(&info)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()?;
        if !status.success() {
            fs::write(&info, &original)?;
            bail!("cannot set {key} in Info.plist");
        }
    }
    let entitlements = work.join("Entitlements.macos.plist");
    fs::write(&entitlements, ENTITLEMENTS)?;
    let signed = sign(bundle, &entitlements);
    let _ = fs::remove_dir_all(&work);
    if let Err(error) = signed {
        // An Info.plist the signature doesn't cover is worse than an old one.
        if !changed.is_empty() {
            fs::write(&info, &original)?;
            let _ = sign(bundle, Path::new(""));
        }
        return Err(error);
    }
    let _ = Command::new(LSREGISTER)
        .arg("-f")
        .arg(bundle)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    if !changed.is_empty() {
        log::info!(
            "Updated the app's {}",
            changed
                .iter()
                .map(|(key, _)| key.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        );
    }
    Ok(())
}

/// Sign as `build.sh` does: with its local identity when this Mac has one,
/// so Keychain keeps trusting Lyssna, else ad hoc.
fn sign(bundle: &Path, entitlements: &Path) -> Result<()> {
    let mut command = Command::new(CODESIGN);
    command.args(["--force", "--deep"]);
    if entitlements.is_file() {
        command.arg("--entitlements").arg(entitlements);
    }
    match local_identity() {
        Some((fingerprint, keychain)) => {
            command
                .args(["--options", "runtime", "--sign", &fingerprint, "--keychain"])
                .arg(keychain);
        }
        None => {
            command.args(["--sign", "-"]);
        }
    }
    let status = command
        .arg(bundle)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()?;
    ensure!(status.success(), "codesign failed");
    Ok(())
}

/// `build.sh`'s signing identity, with its keychain unlocked. Its password
/// is the build script's own, kept beside it for this account only.
fn local_identity() -> Option<(String, PathBuf)> {
    #[derive(serde::Deserialize)]
    struct Identity {
        fingerprint: String,
        password: String,
    }
    let home = directories::BaseDirs::new()?.home_dir().to_path_buf();
    // Under SpotiFlex's names until the build script moves them.
    let pick = |current: PathBuf, former: PathBuf| if current.exists() { current } else { former };
    let metadata = pick(
        home.join("Library/Application Support/Lyssna/build-signing/identity.json"),
        home.join("Library/Application Support/SpotiFlex/build-signing/identity.json"),
    );
    let keychain = pick(
        home.join("Library/Keychains/Lyssna-local-build.keychain-db"),
        home.join("Library/Keychains/SpotiFlex-local-build.keychain-db"),
    );
    let identity: Identity = serde_json::from_slice(&fs::read(metadata).ok()?).ok()?;
    if identity.fingerprint.len() != 40
        || !identity
            .fingerprint
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
        || !keychain.is_file()
    {
        return None;
    }
    let unlocked = Command::new(SECURITY)
        .args(["unlock-keychain", "-p", &identity.password])
        .arg(&keychain)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success());
    unlocked.then_some((identity.fingerprint, keychain))
}

fn top_level_keys(plist: &Path) -> Result<Vec<String>> {
    let output = Command::new(PLUTIL)
        .args(["-convert", "json", "-o", "-"])
        .arg(plist)
        .stderr(Stdio::null())
        .output()?;
    ensure!(output.status.success(), "cannot read Info.macos.plist");
    let value: serde_json::Value = serde_json::from_slice(&output.stdout)?;
    Ok(value
        .as_object()
        .context("Info.macos.plist is not a dictionary")?
        .keys()
        .cloned()
        .collect())
}

/// One key's value, compared by content rather than layout.
fn extract(plist: &Path, key: &str) -> Result<serde_json::Value> {
    let output = Command::new(PLUTIL)
        .args(["-extract", key, "json", "-o", "-"])
        .arg(plist)
        .stderr(Stdio::null())
        .output()?;
    ensure!(output.status.success(), "no {key}");
    Ok(serde_json::from_slice(&output.stdout)?)
}

fn tempfile_dir() -> Result<PathBuf> {
    let dir = std::env::temp_dir().join(format!("lyssna-bundle-{}", std::process::id()));
    fs::create_dir_all(&dir)?;
    Ok(dir)
}
