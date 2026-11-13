use crate::{db::Database, models::*, storage};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

pub fn chapter_directory(root: &Path, comic: &Comic, chapter: &Chapter) -> Result<PathBuf, String> {
    let dir = root
        .join(format!(
            "{}-{}",
            storage::slug(&comic.title),
            storage::short_id(&comic.id)
        ))
        .join(format!(
            "{:05}-{}-{}",
            chapter.index,
            storage::slug(&chapter.title),
            storage::short_id(&chapter.id)
        ));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    storage::inside(root, &dir, false)
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
