use std::{
    fs,
    path::{Path, PathBuf},
};
pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    // Don't leak OS error strings (they can contain absolute local paths).
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|_| "无法创建缓存目录")?;
    }
    let temporary = path.with_extension(format!("part-{}", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|_| "无法写入缓存文件")?;
        file.write_all(bytes).map_err(|_| "无法写入缓存文件")?;
        file.sync_all().map_err(|_| "无法写入缓存文件")?;
        drop(file);
        fs::rename(&temporary, path).map_err(|_| "无法写入缓存文件")
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result.map_err(|e| e.to_string())
}
pub fn inside(root: &Path, path: &Path, allow_root: bool) -> Result<PathBuf, String> {
    let root = fs::canonicalize(root).map_err(|_| "下载目录不存在")?;
    let path = fs::canonicalize(path).map_err(|_| "文件或目录不存在")?;
    if !path.starts_with(&root) || !allow_root && path == root {
        return Err("路径超出下载目录".into());
    }
    Ok(path)
}
pub fn slug(input: &str) -> String {
    let value: String = input
        .chars()
        .map(|c| {
            if c.is_control() || "<>:\"/\\|?*".contains(c) {
                '_'
            } else {
                c
            }
        })
        .take(60)
        .collect();
    let value = value.trim().trim_matches(['.', ' ']);
    if value.is_empty() {
        "book".into()
    } else {
        value.into()
    }
}
/// 纯名字目录用的清洗：在 slug 基础上再挡 Windows 保留设备名
/// （CON/NUL/COM1...，以前靠哈希后缀天然避开，纯名字后必须显式处理）。
pub fn safe_name(input: &str) -> String {
    let mut value = slug(input);
    let upper = value.to_ascii_uppercase();
    let stem = upper.split_once('.').map_or(upper.as_str(), |(s, _)| s);
    const RESERVED: [&str; 22] = [
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7",
        "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    if RESERVED.contains(&stem) {
        value.push('_');
    }
    value
}
pub fn short_id(value: &str) -> String {
    use sha2::{Digest, Sha256};
    hex::encode(Sha256::digest(value.as_bytes()))[..12].into()
}
pub fn natural_key(value: &str) -> String {
    let mut key = String::new();
    let mut digits = String::new();
    for c in value.chars() {
        if c.is_ascii_digit() {
            digits.push(c);
        } else {
            if !digits.is_empty() {
                key.push_str(&format!("{:0>16}", digits));
                digits.clear();
            }
            key.push(c);
        }
    }
    if !digits.is_empty() {
        key.push_str(&format!("{:0>16}", digits));
    }
    key
}
pub fn image_files(root: &Path, dir: &Path) -> Result<Vec<PathBuf>, String> {
    // Validate (and canonicalize) the directory exactly once instead of
    // canonicalizing every single file. Entries are then read relative to that
    // already-validated directory, so no per-file path traversal check is
    // needed; symlink_metadata (which does not follow links) skips both
    // directories and symlink escapes.
    let dir = inside(root, dir, false)?;
    let mut files = Vec::new();
    for entry in fs::read_dir(dir).map_err(|_| "无法读取章节目录")?.flatten() {
        let p = entry.path();
        let ext = p
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if ["jpg", "jpeg", "png", "webp", "gif", "bmp"].contains(&ext.as_str())
            && fs::symlink_metadata(&p).is_ok_and(|m| m.is_file())
        {
            files.push(p);
        }
    }
    files.sort_by_key(|p| natural_key(&p.file_name().unwrap_or_default().to_string_lossy()));
    Ok(files)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_parent_paths_and_symlink_escape() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("books");
        fs::create_dir(&root).unwrap();
        assert!(inside(&root, temp.path(), false).is_err());
        assert!(inside(&root, &root, false).is_err());
        #[cfg(unix)]
        {
            let link = root.join("external");
            std::os::unix::fs::symlink(temp.path(), &link).unwrap();
            assert!(inside(&root, &link, false).is_err());
        }
    }
    #[test]
    fn names_have_safe_stable_identity_and_natural_order() {
        assert!(!slug("../comic/one").contains('/'));
        assert_eq!(short_id("same"), short_id("same"));
        assert_ne!(short_id("one"), short_id("two"));
        assert!(natural_key("002.jpg") < natural_key("010.jpg"));
    }
}
