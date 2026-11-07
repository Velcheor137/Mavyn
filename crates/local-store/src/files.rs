use sha2::{Digest, Sha256};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;

/// Same-directory temporary file, durable contents, atomic replacement and directory flush.
pub fn write_atomic(target: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let dir = target.parent().ok_or(std::io::ErrorKind::InvalidInput)?;
    fs::create_dir_all(dir)?;
    let tmp = dir.join(format!(
        ".{}.{}.tmp",
        target
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("file"),
        uuid::Uuid::new_v4()
    ));
    let result = (|| {
        let mut file = OpenOptions::new().write(true).create_new(true).open(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&tmp, target)?;
        #[cfg(unix)]
        std::fs::File::open(dir)?.sync_all()?;
        Ok(())
    })();
    if result.is_err() {
        // Best effort after a failed replacement; preserve the original I/O error.
        let _ = fs::remove_file(&tmp);
    }
    result
}

fn io_code(error: std::io::Error) -> String {
    match error.kind() {
        std::io::ErrorKind::NotFound => "file.not_found",
        std::io::ErrorKind::PermissionDenied => "file.permission_denied",
        _ => "storage.failed",
    }
    .into()
}

/// Always hash current bytes, even when filesystem size/mtime appear unchanged.
/// An unrelated process can still race the final replace; fingerprinting is not an OS lock.
pub fn write_linked_checked(path: &Path, bytes: &[u8], expected_hash: &str) -> Result<(), String> {
    let current = fs::read(path).map_err(io_code)?;
    if hex::encode(Sha256::digest(&current)) != expected_hash {
        return Err("file.external_change".into());
    }
    write_atomic(path, bytes).map_err(io_code)
}
