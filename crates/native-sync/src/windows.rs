use crate::{Result, Vault};

/// Windows Credential Manager, scoped by the canonical server URL hash.
pub struct WindowsVault;
impl Vault for WindowsVault {
    fn get(&self, key: &str) -> Result<Option<String>> {
        let entry = keyring::Entry::new("app.mavyn.sync", key).map_err(|_| "storage.failed")?;
        match entry.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err("storage.failed"),
        }
    }
    fn set(&self, key: &str, value: &str) -> Result<()> {
        keyring::Entry::new("app.mavyn.sync", key)
            .and_then(|entry| entry.set_password(value))
            .map_err(|_| "storage.failed")
    }
    fn delete(&self, key: &str) -> Result<()> {
        let entry = keyring::Entry::new("app.mavyn.sync", key).map_err(|_| "storage.failed")?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err("storage.failed"),
        }
    }
}
