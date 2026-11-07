use mavyn_local_store::files::{write_atomic, write_linked_checked};
use sha2::{Digest, Sha256};

#[test]
fn changed_same_size_content_is_never_overwritten() {
    let dir = std::env::temp_dir().join(format!("mavyn-files-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).expect("dir");
    let path = dir.join("заметка.md");
    write_atomic(&path, b"aaaa").expect("save original");
    let modified = std::fs::metadata(&path)
        .expect("metadata")
        .modified()
        .expect("mtime");
    let expected = hex::encode(Sha256::digest(b"aaaa"));
    write_atomic(&path, b"bbbb").expect("external edit");
    std::fs::OpenOptions::new()
        .write(true)
        .open(&path)
        .expect("open")
        .set_times(std::fs::FileTimes::new().set_modified(modified))
        .expect("restore mtime");
    assert_eq!(
        write_linked_checked(&path, b"mine", &expected).expect_err("must conflict"),
        "file.external_change"
    );
    assert_eq!(std::fs::read(&path).expect("read"), b"bbbb");
    let current = hex::encode(Sha256::digest(b"bbbb"));
    write_linked_checked(&path, "# Привет\r\n".as_bytes(), &current).expect("safe save");
    assert_eq!(
        std::fs::read_to_string(&path).expect("read"),
        "# Привет\r\n"
    );
    assert_eq!(std::fs::read_dir(&dir).expect("files").count(), 1);
    std::fs::remove_dir_all(dir).expect("cleanup");
}
