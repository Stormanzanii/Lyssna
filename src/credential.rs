//! Platform credential storage. macOS uses authenticated encrypted local files.
#[cfg(not(target_os = "macos"))]
pub use keyring::{Entry, Error};
#[cfg(target_os = "macos")]
pub use local::{Entry, Error};

#[cfg(target_os = "macos")]
mod local {
    use anyhow::{Context, Result, ensure};
    use ring::aead::{AES_256_GCM, Aad, LessSafeKey, Nonce, UnboundKey};
    use sha2::{Digest, Sha256};
    use std::{
        fs::{self, DirBuilder, File, OpenOptions, Permissions},
        io::{Read, Write},
        os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt},
        path::{Path, PathBuf},
        sync::Mutex,
    };
    use zeroize::Zeroizing;

    const HEADER: &[u8; 8] = b"SFSEAL1\0";
    const LIMIT: usize = 1024 * 1024;
    static LOCK: Mutex<()> = Mutex::new(());

    #[derive(Debug)]
    pub enum Error {
        NoEntry,
        Storage(anyhow::Error),
    }
    impl std::fmt::Display for Error {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            match self {
                Self::NoEntry => f.write_str("No saved credential"),
                Self::Storage(error) => write!(f, "Local credential storage failed: {error:#}"),
            }
        }
    }
    impl std::error::Error for Error {
        fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
            match self {
                Self::Storage(error) => Some(error.as_ref()),
                Self::NoEntry => None,
            }
        }
    }
    impl From<anyhow::Error> for Error {
        fn from(error: anyhow::Error) -> Self {
            Self::Storage(error)
        }
    }
    fn absent(error: anyhow::Error) -> Error {
        if error
            .downcast_ref::<std::io::Error>()
            .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound)
        {
            Error::NoEntry
        } else {
            Error::Storage(error)
        }
    }
    fn random<const N: usize>() -> Result<[u8; N]> {
        let mut bytes = [0; N];
        getrandom::fill(&mut bytes)
            .map_err(|_| anyhow::anyhow!("Secure randomness unavailable"))?;
        Ok(bytes)
    }
    fn secure_directory(path: &Path, create: bool) -> Result<()> {
        if create {
            DirBuilder::new().recursive(true).mode(0o700).create(path)?;
        }
        let metadata = fs::symlink_metadata(path)?;
        // The directory and every file must belong to the current OS account.
        ensure!(
            metadata.is_dir() && metadata.uid() == unsafe { libc::geteuid() },
            "Credential directory has an invalid owner or type"
        );
        fs::set_permissions(path, Permissions::from_mode(0o700))?;
        Ok(())
    }
    fn read_private(path: &Path, limit: usize) -> Result<Zeroizing<Vec<u8>>> {
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(path)?;
        let metadata = file.metadata()?;
        ensure!(
            metadata.is_file() && metadata.uid() == unsafe { libc::geteuid() },
            "Credential file has an invalid owner or type"
        );
        file.set_permissions(Permissions::from_mode(0o600))?;
        let mut bytes = Zeroizing::new(Vec::new());
        file.take((limit + 1) as u64).read_to_end(&mut bytes)?;
        ensure!(
            bytes.len() <= limit,
            "Credential file exceeds its size limit"
        );
        Ok(bytes)
    }
    fn encryption_key(root: &Path, create: bool) -> Result<LessSafeKey> {
        let path = root.join("device.key");
        let bytes = match read_private(&path, 32) {
            Ok(bytes) => bytes,
            Err(error)
                if create
                    && error
                        .downcast_ref::<std::io::Error>()
                        .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound) =>
            {
                ensure!(
                    !fs::read_dir(root)?.any(|entry| entry.ok().is_some_and(|entry| entry
                        .path()
                        .extension()
                        .is_some_and(|ext| ext == "sealed"))),
                    "Credential encryption key is missing; restore it from your device backup"
                );
                let bytes = Zeroizing::new(random::<32>()?);
                let mut file = OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .mode(0o600)
                    .open(&path)?;
                file.write_all(bytes.as_ref())?;
                file.sync_all()?;
                File::open(root)?.sync_all()?;
                Zeroizing::new(bytes.to_vec())
            }
            Err(error) => return Err(error.context("Cannot read credential encryption key")),
        };
        ensure!(bytes.len() == 32, "Credential encryption key is damaged");
        UnboundKey::new(&AES_256_GCM, bytes.as_slice())
            .map(LessSafeKey::new)
            .map_err(|_| anyhow::anyhow!("Cannot initialize credential encryption"))
    }

    pub struct Entry {
        identity: Vec<u8>,
        filename: String,
        directory: PathBuf,
    }
    impl Entry {
        pub fn new(service: &str, user: &str) -> std::result::Result<Self, Error> {
            let identity = serde_json::to_vec(&(service, user)).map_err(anyhow::Error::from)?;
            Ok(Self {
                filename: format!("{:x}.sealed", Sha256::digest(&identity)),
                identity,
                directory: crate::config::data_dir()?.join("credentials"),
            })
        }
        pub fn get_password(&self) -> std::result::Result<String, Error> {
            let _guard = LOCK
                .lock()
                .map_err(|_| anyhow::anyhow!("Credential store unavailable"))?;
            let root = &self.directory;
            secure_directory(root, false).map_err(absent)?;
            let bytes = read_private(&root.join(&self.filename), LIMIT).map_err(absent)?;
            ensure_record(&bytes)?;
            let nonce = Nonce::try_assume_unique_for_key(&bytes[8..20])
                .map_err(|_| anyhow::anyhow!("Saved credential nonce is invalid"))?;
            let mut payload = Zeroizing::new(bytes[20..].to_vec());
            let key = encryption_key(root, false)?;
            let plaintext = key
                .open_in_place(nonce, Aad::from(self.identity.as_slice()), &mut payload)
                .map_err(|_| anyhow::anyhow!("Saved credential failed authentication"))?;
            String::from_utf8(plaintext.to_vec())
                .context("Saved credential is not valid text")
                .map_err(Error::from)
        }
        pub fn set_password(&self, value: &str) -> std::result::Result<(), Error> {
            let _guard = LOCK
                .lock()
                .map_err(|_| anyhow::anyhow!("Credential store unavailable"))?;
            if value.len() > LIMIT - 36 {
                return Err(anyhow::anyhow!("Credential exceeds its size limit").into());
            }
            let root = &self.directory;
            secure_directory(root, true)?;
            let key = encryption_key(root, true)?;
            let nonce = random::<12>()?;
            let mut payload = Zeroizing::new(value.as_bytes().to_vec());
            key.seal_in_place_append_tag(
                Nonce::assume_unique_for_key(nonce),
                Aad::from(self.identity.as_slice()),
                &mut *payload,
            )
            .map_err(|_| anyhow::anyhow!("Cannot encrypt credential"))?;
            let temporary = root.join(format!(
                ".write-{:032x}",
                u128::from_le_bytes(random::<16>()?)
            ));
            let result = (|| -> Result<()> {
                let mut file = OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .mode(0o600)
                    .open(&temporary)?;
                file.write_all(HEADER)?;
                file.write_all(&nonce)?;
                file.write_all(&payload)?;
                file.sync_all()?;
                fs::rename(&temporary, root.join(&self.filename))?;
                File::open(root)?.sync_all()?;
                Ok(())
            })();
            if result.is_err() {
                let _ = fs::remove_file(temporary);
            }
            result.map_err(Error::from)
        }
        pub fn delete_credential(&self) -> std::result::Result<(), Error> {
            let _guard = LOCK
                .lock()
                .map_err(|_| anyhow::anyhow!("Credential store unavailable"))?;
            let root = &self.directory;
            secure_directory(root, false).map_err(absent)?;
            fs::remove_file(root.join(&self.filename))
                .map_err(anyhow::Error::from)
                .map_err(absent)?;
            File::open(root)
                .and_then(|file| file.sync_all())
                .map_err(anyhow::Error::from)?;
            Ok(())
        }
    }
    fn ensure_record(bytes: &[u8]) -> Result<()> {
        ensure!(
            bytes.len() >= 36 && &bytes[..8] == HEADER,
            "Saved credential is damaged or unsupported"
        );
        Ok(())
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        struct Directory(PathBuf);
        impl Directory {
            fn new() -> Self {
                let path = std::env::temp_dir().join(format!(
                    "spotiflex-credentials-{:032x}",
                    u128::from_le_bytes(random::<16>().unwrap())
                ));
                Self(path)
            }
            fn entry(&self, service: &str, user: &str) -> Entry {
                let mut entry = Entry::new(service, user).unwrap();
                entry.directory = self.0.clone();
                entry
            }
        }
        impl Drop for Directory {
            fn drop(&mut self) {
                let _ = fs::remove_dir_all(&self.0);
            }
        }

        #[test]
        fn credentials_restore_replace_and_delete_with_private_permissions() {
            let directory = Directory::new();
            let entry = directory.entry("test-service", "account");
            assert!(matches!(entry.get_password(), Err(Error::NoEntry)));
            entry.set_password("test credential").unwrap();
            let path = directory.0.join(&entry.filename);
            let first = fs::read(&path).unwrap();
            assert!(!first.windows(15).any(|part| part == b"test credential"));
            assert_eq!(
                fs::metadata(&directory.0).unwrap().permissions().mode() & 0o777,
                0o700
            );
            for file in [&path, &directory.0.join("device.key")] {
                assert_eq!(
                    fs::metadata(file).unwrap().permissions().mode() & 0o777,
                    0o600
                );
            }
            assert_eq!(
                directory
                    .entry("test-service", "account")
                    .get_password()
                    .unwrap(),
                "test credential"
            );
            entry.set_password("test credential").unwrap();
            assert_ne!(&first[8..20], &fs::read(&path).unwrap()[8..20]);
            entry.set_password("replacement").unwrap();
            assert_eq!(entry.get_password().unwrap(), "replacement");
            entry.delete_credential().unwrap();
            assert!(matches!(entry.get_password(), Err(Error::NoEntry)));
            assert!(matches!(entry.delete_credential(), Err(Error::NoEntry)));
        }

        #[test]
        fn ciphertext_rejects_tampering_other_accounts_and_missing_keys() {
            let directory = Directory::new();
            let entry = directory.entry("service", "account");
            entry.set_password("test credential").unwrap();
            let path = directory.0.join(&entry.filename);
            let original = fs::read(&path).unwrap();
            for other in [
                directory.entry("service", "other-account"),
                directory.entry("other-service", "account"),
            ] {
                fs::write(directory.0.join(&other.filename), &original).unwrap();
                assert!(matches!(other.get_password(), Err(Error::Storage(_))));
            }
            let mut corrupted = original.clone();
            *corrupted.last_mut().unwrap() ^= 1;
            fs::write(&path, corrupted).unwrap();
            assert!(matches!(entry.get_password(), Err(Error::Storage(_))));
            fs::write(&path, &original[..20]).unwrap();
            assert!(matches!(entry.get_password(), Err(Error::Storage(_))));
            fs::write(&path, &original).unwrap();
            fs::remove_file(directory.0.join("device.key")).unwrap();
            assert!(matches!(entry.get_password(), Err(Error::Storage(_))));
            assert!(entry.set_password("replacement").is_err());
            assert_eq!(fs::read(path).unwrap(), original);
        }

        #[test]
        fn credential_files_reject_symlinks_and_oversized_writes() {
            use std::os::unix::fs::symlink;
            let directory = Directory::new();
            let entry = directory.entry("service", "account");
            entry.set_password("test credential").unwrap();
            assert!(entry.set_password(&"x".repeat(LIMIT)).is_err());
            assert_eq!(entry.get_password().unwrap(), "test credential");
            let path = directory.0.join(&entry.filename);
            let original = directory.0.join("original.sealed");
            fs::rename(&path, &original).unwrap();
            symlink(&original, &path).unwrap();
            assert!(matches!(entry.get_password(), Err(Error::Storage(_))));
        }
    }
}
