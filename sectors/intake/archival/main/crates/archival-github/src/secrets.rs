//! secrets live in the os keychain (macos keychain, windows credential manager, linux kernel
//! keyring with a persistent backing). never in the index, config files or logs.

use anyhow::{anyhow, Result};

const SERVICE: &str = "archival";

fn entry(key: &str) -> Result<keyring::Entry> {
    keyring::Entry::new(SERVICE, key).map_err(|e| anyhow!("keychain unavailable: {e}"))
}

pub fn set(key: &str, value: &str) -> Result<()> {
    entry(key)?.set_password(value).map_err(|e| anyhow!("couldn't save to the keychain: {e}"))
}

pub fn get(key: &str) -> Result<Option<String>> {
    match entry(key)?.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(anyhow!("couldn't read the keychain: {e}")),
    }
}

pub fn delete(key: &str) -> Result<()> {
    match entry(key)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(anyhow!("couldn't remove from the keychain: {e}")),
    }
}
