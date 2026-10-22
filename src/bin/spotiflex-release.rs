use spotiflex::credential as keyring;
use std::{
    fs::{self, File},
    io::Write,
    path::Path,
    process::{Command, Stdio},
    time::Duration,
};

use anyhow::{Context, Result, bail, ensure};
use base64::{Engine, engine::general_purpose::STANDARD};
use ed25519_dalek::{Signer, SigningKey};
use spotiflex::updater::{BASE_URL, Envelope, Manifest, TARGET, file_hash};

fn secret(name: &str) -> Result<String> {
    if let Ok(value) = std::env::var(format!(
        "SPOTIFLEX_RELEASE_{}",
        name.to_uppercase().replace('-', "_")
    )) {
        return Ok(value);
    }
    keyring::Entry::new("SpotiFlex/Release", name)?
        .get_password()
        .context("Release credentials missing; run setup-keys first")
}

fn signing_key() -> Result<SigningKey> {
    let bytes: [u8; 32] = STANDARD
        .decode(secret("signing-key")?.trim())?
        .try_into()
        .map_err(|_| anyhow::anyhow!("Invalid release signing key"))?;
    Ok(SigningKey::from_bytes(&bytes))
}

fn setup() -> Result<()> {
    for name in ["signing-key", "publish-token"] {
        let entry = keyring::Entry::new("SpotiFlex/Release", name)?;
        match entry.get_password() {
            Ok(_) => {}
            Err(keyring::Error::NoEntry) => {
                let mut bytes = [0u8; 32];
                getrandom::fill(&mut bytes)
                    .map_err(|_| anyhow::anyhow!("Cannot generate release credentials"))?;
                entry.set_password(&STANDARD.encode(bytes))?;
            }
            Err(error) => return Err(error.into()),
        }
    }
    let public_key = STANDARD.encode(signing_key()?.verifying_key().to_bytes());
    fs::create_dir_all("config")?;
    fs::write("config/update-public-key.base64", format!("{public_key}\n"))?;
    let path = "infra/updates/wrangler.jsonc";
    let mut configuration: serde_json::Value = serde_json::from_slice(&fs::read(path)?)?;
    configuration["vars"]["UPDATE_PUBLIC_KEY"] = public_key.into();
    fs::write(
        path,
        format!("{}\n", serde_json::to_string_pretty(&configuration)?),
    )?;
    println!(
        "Release credentials saved in OS credential store; public verification key configured."
    );
    Ok(())
}

fn github_secrets() -> Result<()> {
    for (name, key) in [
        ("SPOTIFLEX_RELEASE_SIGNING_KEY", "signing-key"),
        ("SPOTIFLEX_RELEASE_PUBLISH_TOKEN", "publish-token"),
    ] {
        let value = secret(key)?;
        let mut child = Command::new("gh")
            .args(["secret", "set", name, "--repo", "Stormanzanii/SpotiFlex"])
            .stdin(Stdio::piped())
            .spawn()?;
        child
            .stdin
            .take()
            .context("Cannot open secret input")?
            .write_all(value.as_bytes())?;
        ensure!(
            child.wait()?.success(),
            "Cannot configure GitHub release secret"
        );
    }
    println!("GitHub release secrets configured.");
    Ok(())
}

fn upload(client: &reqwest::blocking::Client, path: &str, file: &Path, token: &str) -> Result<()> {
    let size = fs::metadata(file)?.len();
    let response = client
        .put(format!("{BASE_URL}/publish/{path}"))
        .bearer_auth(token)
        .header("Content-Length", size)
        .body(reqwest::blocking::Body::new(File::open(file)?))
        .send()
        .map_err(|_| anyhow::anyhow!("Cannot upload release artifact"))?;
    ensure!(
        response.status().is_success(),
        "Release upload failed (HTTP {})",
        response.status().as_u16()
    );
    Ok(())
}

fn publish(arguments: &[String], upload_files: bool) -> Result<()> {
    ensure!(
        arguments.len() == 3,
        "Usage: spotiflex-release prepare|publish VERSION EXE NOTES_FILE"
    );
    let version = semver::Version::parse(&arguments[0])?;
    ensure!(
        version.pre.is_empty() && version.build.is_empty(),
        "Stable versions must use MAJOR.MINOR.PATCH"
    );
    ensure!(
        arguments[0] == env!("CARGO_PKG_VERSION"),
        "Release version must match Cargo.toml"
    );
    let executable = Path::new(&arguments[1]);
    let notes = fs::read_to_string(&arguments[2])?;
    ensure!(notes.len() <= 16_384, "Release notes exceed limit");
    let directory = Path::new("dist").join(format!("{version}"));
    fs::create_dir_all(&directory)?;
    let manifest = Manifest {
        version: version.to_string(),
        target: TARGET.into(),
        artifact: format!("releases/{version}/{TARGET}/spotiflex.exe"),
        sha256: file_hash(executable)?,
        size: fs::metadata(executable)?.len(),
        notes,
    };
    let key = signing_key()?;
    ensure!(
        STANDARD.encode(key.verifying_key().to_bytes()) == spotiflex::updater::PUBLIC_KEY.trim(),
        "Release signing key does not match the compiled public key; rebuild first"
    );
    let payload = serde_json::to_vec(&manifest)?;
    let envelope = Envelope {
        signature: STANDARD.encode(key.sign(&payload).to_bytes()),
        payload: STANDARD.encode(payload),
    };
    let channel = directory.join("windows-x86_64.json");
    fs::write(&channel, serde_json::to_vec_pretty(&envelope)?)?;
    let source = directory.join("source.zip");
    ensure!(
        Command::new("git")
            .args(["archive", "--format=zip", "--output"])
            .arg(&source)
            .arg("HEAD")
            .status()?
            .success(),
        "Cannot create corresponding source archive"
    );
    if upload_files {
        let token = secret("publish-token")?;
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(600))
            .redirect(reqwest::redirect::Policy::none())
            .build()?;
        upload(&client, &manifest.artifact, executable, &token)?;
        upload(
            &client,
            &format!("releases/{version}/{TARGET}/source.zip"),
            &source,
            &token,
        )?;
        upload(
            &client,
            &format!("channels/stable/{TARGET}.json"),
            &channel,
            &token,
        )?;
        println!("Published signed version {version} to R2.");
    } else {
        println!(
            "Prepared signed version {version} in {}.",
            directory.display()
        );
    }
    Ok(())
}

fn main() -> Result<()> {
    let arguments: Vec<_> = std::env::args().skip(1).collect();
    match arguments.first().map(String::as_str) {
        Some("setup-keys") => setup(),
        Some("sync-github") => github_secrets(),
        // Deployment automation consumes this through a protected pipe only.
        Some("deploy-token") => {
            print!("{}", secret("publish-token")?);
            Ok(())
        }
        Some("prepare") => publish(&arguments[1..], false),
        Some("publish") => publish(&arguments[1..], true),
        _ => bail!("Commands: setup-keys, sync-github, prepare, publish"),
    }
}
