use crate::{db::Database, models::*, storage};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

/// 下载目录命名：漫画和章节都用纯粹的名字（`斗破苍穹/第12话 陨落的天才/`），
/// 方便下载后直接整理。两个防撞机制兜底：
/// - 同名不同 id（漫画重名/章节重名）自动加短哈希后缀消歧；
/// - Windows 保留设备名（CON/NUL/...）追加下划线。
/// 旧版"名字-hash / 序号-名字-hash"目录在再次下载时自动改名迁移到纯名字。
pub fn chapter_directory(
    root: &Path,
    comic: &Comic,
    chapter: &Chapter,
    db: &Database,
    used: &mut std::collections::HashSet<(PathBuf, String, String)>,
) -> Result<PathBuf, String> {
    let comic_dir = ensure_comic_dir(root, comic, db)?;
    let base = comic_dir.join(storage::safe_name(&chapter.title));
    std::fs::create_dir_all(&base).map_err(|e| e.to_string())?;
    let resolved = storage::inside(root, &base, false)?;
    // 占用判定（按优先级）：
    // 1) 同一批入队里已用过该目录（DB 还没来得及记录）；
    // 2) 目录已登记在其他章节名下（历史下载）。
    // 命中即加短哈希消歧，避免两章写进同一目录。
    // 本批中其他章节已占用同一目录才算冲突；同章节重入队（重试）不算
    let taken_by_batch = used.iter().any(|(p, c, ch)| {
        p.as_path() == resolved.as_path() && (c != &comic.id || ch != &chapter.id)
    });
    let taken_by_db =
        dir_registered_to_other(root, db, &comic.id, Some(&chapter.id), &base).unwrap_or(false);
    if taken_by_batch || taken_by_db {
        let disambiguated = comic_dir.join(format!(
            "{}-{}",
            storage::safe_name(&chapter.title),
            storage::short_id(&chapter.id)
        ));
        std::fs::create_dir_all(&disambiguated).map_err(|e| e.to_string())?;
        let resolved = storage::inside(root, &disambiguated, false)?;
        used.insert((resolved.clone(), comic.id.clone(), chapter.id.clone()));
        return Ok(resolved);
    }
    used.insert((resolved.clone(), comic.id.clone(), chapter.id.clone()));
    Ok(resolved)
}

/// 确定漫画目录：优先纯名字；旧格式（名字-hash）目录存在时改名迁移并同步 DB；
/// 纯名字目录已被其他漫画占用时回退到"名字-hash"。
fn ensure_comic_dir(root: &Path, comic: &Comic, db: &Database) -> Result<PathBuf, String> {
    let name = storage::safe_name(&comic.title);
    let plain = root.join(&name);
    let legacy = root.join(format!("{}-{}", name, storage::short_id(&comic.id)));
    if plain.exists() {
        if dir_registered_to_other(root, db, &comic.id, None, &plain)? {
            // 同名目录已被其他漫画占用：落到 名字-短哈希 目录
            std::fs::create_dir_all(&legacy).map_err(|e| e.to_string())?;
            return storage::inside(root, &legacy, false);
        }
        return storage::inside(root, &plain, false);
    }
    if legacy.exists() {
        // 旧命名 → 纯名字：同盘改名秒完成；失败（被占用等）就沿用旧目录，不影响功能
        if std::fs::rename(&legacy, &plain).is_ok() {
            rebind_comic_dir(db, root, &comic.id, &legacy, &plain);
            return storage::inside(root, &plain, false);
        }
        return storage::inside(root, &legacy, false);
    }
    std::fs::create_dir_all(&plain).map_err(|e| e.to_string())?;
    storage::inside(root, &plain, false)
}

/// 目录是否已登记给了"其他漫画/其他章节"的下载记录（章节级消歧用）。
/// DB 里的 directory 是 canonicalize 过的章节目录本身，直接做尾分隔符无关的精确比较；
/// 少数旧记录若带子路径，再按分隔符前缀兜底。
fn dir_registered_to_other(
    root: &Path,
    db: &Database,
    comic_id: &str,
    chapter_id: Option<&str>,
    dir: &Path,
) -> Result<bool, String> {
    // 与 DB 中的 canonicalize 路径对齐形式（目录存在时规范化；不存在则按原样比较）
    let dir = std::fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());
    let root = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    let dir_norm = dir
        .to_string_lossy()
        .trim_end_matches(['/', '\\'])
        .to_string();
    let dir_prefix = format!("{dir_norm}{}", std::path::MAIN_SEPARATOR);
    #[cfg(test)]
    eprintln!("[dbg] dir_norm={dir_norm} comic={comic_id} chapter={chapter_id:?}");
    for chapter in db.local_chapters(&root.to_string_lossy(), None)? {
        #[cfg(test)]
        eprintln!(
            "[dbg]   rec comic={} id={} dir={}",
            chapter.comic_id, chapter.id, chapter.directory
        );
        let registered = {
            let d = chapter.directory.trim_end_matches(['/', '\\']);
            d == dir_norm || chapter.directory.starts_with(&dir_prefix)
        };
        if !registered {
            continue;
        }
        if chapter.comic_id != comic_id {
            return Ok(true);
        }
        if let Some(exclude) = chapter_id {
            if chapter.id != exclude {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

/// 漫画目录改名后，把 DB 里该漫画全部章节记录的 directory/pdf_path 同步过来。
/// DB 路径是 canonicalize 过的（Windows 带 \\?\ 前缀），与拼接路径形式不同，
/// 因此按「目录名组件替换」改写，与路径形式无关。
fn rebind_comic_dir(db: &Database, root: &Path, comic_id: &str, old_dir: &Path, new_dir: &Path) {
    let Some(old_name) = old_dir.file_name() else {
        return;
    };
    let Some(new_name) = new_dir.file_name() else {
        return;
    };
    let root_id = root.to_string_lossy().into_owned();
    let Ok(chapters) = db.local_chapters(&root_id, Some(comic_id)) else {
        return;
    };
    for mut chapter in chapters {
        let Some(rebased_dir) = rebase_component(&chapter.directory, old_name, new_name) else {
            continue;
        };
        chapter.directory = rebased_dir;
        chapter.pdf_path = chapter
            .pdf_path
            .as_deref()
            .and_then(|p| rebase_component(p, old_name, new_name));
        let _ = db.save_chapter(&root_id, &chapter);
    }
}
/// 把路径中第一段等于 old_name 的目录组件替换为 new_name；不含该组件返回 None。
fn rebase_component(
    path: &str,
    old_name: &std::ffi::OsStr,
    new_name: &std::ffi::OsStr,
) -> Option<String> {
    let mut out = PathBuf::new();
    let mut replaced = false;
    for component in Path::new(path).components() {
        let os = component.as_os_str();
        if !replaced && os == old_name {
            out.push(new_name);
            replaced = true;
        } else {
            out.push(os);
        }
    }
    replaced.then(|| out.to_string_lossy().into_owned())
}
pub fn list(db: &Database, root: &Path) -> Result<Vec<LibraryBook>, String> {
    let root_id = root.to_string_lossy();
    let mut groups: BTreeMap<String, Vec<LocalChapter>> = BTreeMap::new();
    for mut chapter in db.local_chapters(&root_id, None)? {
        if storage::inside(root, Path::new(&chapter.directory), false).is_err() {
            continue;
        }
        // 单个被删/损坏/无权限的章节目录不应让整个书库列表失败：跳过该章即可
        chapter.page_count = storage::image_files(root, Path::new(&chapter.directory))
            .unwrap_or_default()
            .len();
        chapter.complete =
            chapter.failed_pages.is_empty() && chapter.page_count as u64 >= chapter.total;
        chapter.pdf_path = chapter
            .pdf_path
            .filter(|p| storage::inside(root, Path::new(p), false).is_ok());
        groups
            .entry(chapter.comic_id.clone())
            .or_default()
            .push(chapter);
    }
    let mut books = Vec::new();
    for (id, mut chapters) in groups {
        chapters.sort_by_key(|c| c.index);
        if let Some(comic) = db.comic(&id)? {
            books.push(LibraryBook {
                progress: db.progress(&root_id, &id)?,
                comic,
                total_pages: chapters.iter().map(|c| c.page_count).sum(),
                incomplete_count: chapters.iter().filter(|c| !c.complete).count(),
                chapters,
            });
        }
    }
    books.sort_by_key(|b| storage::natural_key(&b.comic.title));
    Ok(books)
}
pub fn files(
    db: &Database,
    root: &Path,
    comic_id: &str,
    chapter_id: &str,
) -> Result<Vec<PathBuf>, String> {
    let chapter = db
        .local_chapter(&root.to_string_lossy(), comic_id, chapter_id)?
        .ok_or("章节尚未下载")?;
    storage::image_files(root, Path::new(&chapter.directory))
}
pub fn delete(
    db: &Database,
    root: &Path,
    comic_id: &str,
    chapters: &[String],
) -> Result<usize, String> {
    let mut done = 0;
    let mut errors = Vec::new();
    for id in chapters {
        let Some(chapter) = db.local_chapter(&root.to_string_lossy(), comic_id, id)? else {
            continue;
        };
        // 先删库记录：即便文件删除失败（占用/权限），也不会留下指向已不存在目录的幽灵记录
        db.remove_chapter(&root.to_string_lossy(), comic_id, id)?;
        done += 1;
        if let Ok(path) = storage::inside(root, Path::new(&chapter.directory), false) {
            if let Err(e) = std::fs::remove_dir_all(path) {
                errors.push(format!("章节目录：{e}"));
            }
        }
        if let Some(pdf) = chapter.pdf_path {
            if let Ok(pdf) = storage::inside(root, Path::new(&pdf), false) {
                if let Err(e) = std::fs::remove_file(pdf) {
                    errors.push(format!("PDF：{e}"));
                }
            }
        }
    }
    if !errors.is_empty() {
        log::warn!("删除章节时有文件未能清理：{}", errors.join("；"));
    }
    Ok(done)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn comic(id: &str, title: &str) -> Comic {
        Comic {
            id: id.into(),
            title: title.into(),
            ..Default::default()
        }
    }
    fn chapter(id: &str, title: &str, index: u64) -> Chapter {
        Chapter {
            id: id.into(),
            title: title.into(),
            index,
            ..Default::default()
        }
    }

    #[test]
    fn uses_plain_names_for_comic_and_chapter() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("books");
        std::fs::create_dir(&root).unwrap();
        let db = Database::open(&temp.path().join("db.sqlite")).unwrap();
        let mut used = std::collections::HashSet::new();
        let dir = chapter_directory(
            &root,
            &comic("c1", "斗破苍穹"),
            &chapter("h1", "第12话 陨落的天才", 12),
            &db,
            &mut used,
        )
        .unwrap();
        let expected =
            std::fs::canonicalize(root.join("斗破苍穹").join("第12话 陨落的天才")).unwrap();
        assert_eq!(Path::new(&dir), expected.as_path());
        // 同一章节再次入队：目录稳定不漂移
        let again = chapter_directory(
            &root,
            &comic("c1", "斗破苍穹"),
            &chapter("h1", "第12话 陨落的天才", 12),
            &db,
            &mut used,
        )
        .unwrap();
        assert_eq!(dir, again);
    }

    #[test]
    fn disambiguates_same_named_comics_and_chapters() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("books");
        std::fs::create_dir(&root).unwrap();
        let db = Database::open(&temp.path().join("db.sqlite")).unwrap();
        // 两部同名漫画：第一部下载完成后 DB 有记录，第二部落到 名字-短哈希 目录
        let mut used = std::collections::HashSet::new();
        let first = chapter_directory(
            &root,
            &comic("a", "同名漫画"),
            &chapter("x1", "第1话", 1),
            &db,
            &mut used,
        )
        .unwrap();
        db.save_comic(&comic("a", "同名漫画")).unwrap();
        db.save_chapter(
            &std::fs::canonicalize(&root).unwrap().to_string_lossy(),
            &LocalChapter {
                id: "x1".into(),
                comic_id: "a".into(),
                title: "第1话".into(),
                index: 1,
                directory: first.to_string_lossy().into_owned(),
                total: 1,
                page_count: 1,
                failed_pages: vec![],
                complete: true,
                pdf_path: None,
            },
        )
        .unwrap();
        let second = chapter_directory(
            &root,
            &comic("b", "同名漫画"),
            &chapter("y1", "第1话", 1),
            &db,
            &mut used,
        )
        .unwrap();
        assert_eq!(
            std::fs::canonicalize(first.parent().unwrap()).unwrap(),
            std::fs::canonicalize(root.join("同名漫画")).unwrap()
        );
        assert_ne!(first.parent().unwrap(), second.parent().unwrap());
        assert!(
            second
                .parent()
                .unwrap()
                .to_string_lossy()
                .contains(&storage::short_id("b"))
        );
        // 同一漫画内两章同名：后到的加短哈希
        let c = chapter_directory(
            &root,
            &comic("a", "同名漫画"),
            &chapter("x2", "特别篇", 2),
            &db,
            &mut used,
        )
        .unwrap();
        let d = chapter_directory(
            &root,
            &comic("a", "同名漫画"),
            &chapter("x3", "特别篇", 3),
            &db,
            &mut used,
        )
        .unwrap();
        assert_ne!(c, d);
        assert!(d.to_string_lossy().contains(&storage::short_id("x3")));
    }

    #[test]
    fn migrates_legacy_hashed_dirs_to_plain_names() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("books");
        std::fs::create_dir(&root).unwrap();
        let db = Database::open(&temp.path().join("db.sqlite")).unwrap();
        // 预置旧格式目录与 DB 记录（directory 为 canonicalize 后的绝对路径）
        let comic = comic("old1", "旧格式漫画");
        db.save_comic(&comic).unwrap();
        let legacy = root.join(format!("旧格式漫画-{}", storage::short_id("old1")));
        let legacy_chapter = legacy.join("00001-第1话-abc");
        std::fs::create_dir_all(&legacy_chapter).unwrap();
        let root_canon = std::fs::canonicalize(&root).unwrap();
        let legacy_canon = std::fs::canonicalize(&legacy).unwrap();
        let chapter_canon = std::fs::canonicalize(&legacy_chapter).unwrap();
        db.save_chapter(
            &root_canon.to_string_lossy(),
            &LocalChapter {
                id: "h9".into(),
                comic_id: "old1".into(),
                title: "第1话".into(),
                index: 1,
                directory: chapter_canon.to_string_lossy().into_owned(),
                total: 1,
                page_count: 1,
                failed_pages: vec![],
                complete: true,
                pdf_path: Some(format!("{}.pdf", chapter_canon.to_string_lossy())),
            },
        )
        .unwrap();
        // 再次下载触发迁移
        let mut used = std::collections::HashSet::new();
        let dir = chapter_directory(
            &root_canon,
            &comic,
            &chapter("h10", "第2话", 2),
            &db,
            &mut used,
        )
        .unwrap();
        let plain = root_canon.join("旧格式漫画");
        assert!(plain.exists(), "旧目录应改名为纯名字");
        assert!(!legacy_canon.exists());
        assert_eq!(
            Path::new(&dir),
            std::fs::canonicalize(plain.join("第2话"))
                .unwrap()
                .as_path()
        );
        // DB 里旧章节的路径同步迁移，书库仍能看到
        let books = list(&db, &root_canon).unwrap();
        assert_eq!(books.len(), 1);
        assert_eq!(
            books[0].chapters.len(),
            1,
            "chapter_directory 只建目录；旧章节记录应保留并迁移"
        );
        let migrated = books[0].chapters.iter().find(|c| c.id == "h9").unwrap();
        assert!(Path::new(&migrated.directory).starts_with(&plain));
    }

    #[test]
    fn reserved_device_names_get_suffix() {
        assert_eq!(storage::safe_name("CON"), "CON_");
        assert_eq!(storage::safe_name("nul"), "nul_");
        assert_eq!(storage::safe_name("正常标题"), "正常标题");
        assert_eq!(storage::safe_name("a/b:c"), "a_b_c");
    }
}
