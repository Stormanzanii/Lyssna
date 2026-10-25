//! Opening SpotiFlex when the user signs in to Windows, as Spotify's
//! "Open Spotify automatically after you log into the computer". The
//! per-user Run key holds the choice, so Task Manager's Startup apps page
//! shows and changes the same setting.
use anyhow::Result;
use serde::{Deserialize, Serialize};

/// Passed by the Run entry when SpotiFlex should start out of the way.
pub const MINIMIZED_ARG: &str = "--minimized";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Launch {
    Off,
    Open,
    Minimized,
}

/// The Run entry's command line for a choice, or `None` to remove it.
fn command_line(exe: &str, launch: Launch) -> Option<String> {
    match launch {
        Launch::Off => None,
        Launch::Open => Some(format!("\"{exe}\"")),
        Launch::Minimized => Some(format!("\"{exe}\" {MINIMIZED_ARG}")),
    }
}

fn parse(command: Option<&str>) -> Launch {
    match command {
        None => Launch::Off,
        Some(command) if command.contains(MINIMIZED_ARG) => Launch::Minimized,
        Some(_) => Launch::Open,
    }
}

#[cfg(windows)]
mod registry {
    use anyhow::{Result, bail};
    use windows::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS};
    use windows::Win32::System::Registry::{
        HKEY_CURRENT_USER, REG_SZ, RRF_RT_REG_SZ, RegDeleteKeyValueW, RegGetValueW, RegSetKeyValueW,
    };
    use windows::core::{HSTRING, PCWSTR};

    const RUN: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
    const NAME: &str = "SpotiFlex";

    pub fn read() -> Result<Option<String>> {
        let (key, name) = (HSTRING::from(RUN), HSTRING::from(NAME));
        let mut buffer = vec![0u16; 2048];
        let mut size = (buffer.len() * 2) as u32;
        let status = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                PCWSTR(key.as_ptr()),
                PCWSTR(name.as_ptr()),
                RRF_RT_REG_SZ,
                None,
                Some(buffer.as_mut_ptr().cast()),
                Some(&mut size),
            )
        };
        if status == ERROR_FILE_NOT_FOUND {
            return Ok(None);
        }
        if status != ERROR_SUCCESS {
            bail!("Cannot read the startup setting");
        }
        let length = (size as usize / 2).saturating_sub(1).min(buffer.len());
        Ok(Some(String::from_utf16_lossy(&buffer[..length])))
    }

    pub fn write(command: Option<&str>) -> Result<()> {
        let (key, name) = (HSTRING::from(RUN), HSTRING::from(NAME));
        let status = match command {
            Some(command) => {
                let mut value: Vec<u16> = command.encode_utf16().collect();
                value.push(0);
                unsafe {
                    RegSetKeyValueW(
                        HKEY_CURRENT_USER,
                        PCWSTR(key.as_ptr()),
                        PCWSTR(name.as_ptr()),
                        REG_SZ.0,
                        Some(value.as_ptr().cast()),
                        (value.len() * 2) as u32,
                    )
                }
            }
            None => match unsafe {
                RegDeleteKeyValueW(
                    HKEY_CURRENT_USER,
                    PCWSTR(key.as_ptr()),
                    PCWSTR(name.as_ptr()),
                )
            } {
                ERROR_FILE_NOT_FOUND => ERROR_SUCCESS,
                status => status,
            },
        };
        if status != ERROR_SUCCESS {
            bail!("Cannot change the startup setting");
        }
        Ok(())
    }
}

#[cfg(windows)]
pub fn get() -> Result<Launch> {
    Ok(parse(registry::read()?.as_deref()))
}

#[cfg(windows)]
pub fn set(launch: Launch) -> Result<()> {
    let exe = std::env::current_exe()?;
    registry::write(command_line(&exe.to_string_lossy(), launch).as_deref())
}

#[cfg(not(windows))]
pub fn get() -> Result<Launch> {
    Ok(Launch::Off)
}

#[cfg(not(windows))]
pub fn set(_launch: Launch) -> Result<()> {
    anyhow::bail!("Opening at sign-in is available on Windows only")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn run_entry_round_trips_each_choice() {
        let exe = r"C:\Users\me\AppData\Local\Programs\SpotiFlex\spotiflex.exe";
        for launch in [Launch::Off, Launch::Open, Launch::Minimized] {
            assert_eq!(parse(command_line(exe, launch).as_deref()), launch);
        }
        assert_eq!(
            command_line(exe, Launch::Minimized).unwrap(),
            format!("\"{exe}\" --minimized")
        );
    }
}
