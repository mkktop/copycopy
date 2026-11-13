use crate::{api, library, models::*, state::AppState, storage};
use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
    sync::Arc,
};
use tauri::State;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;
type App<'a> = State<'a, Arc<AppState>>;

#[tauri::command]
pub fn app_snapshot(app: tauri::AppHandle, state: App<'_>) -> Result<serde_json::Value, String> {
    let settings = { state.settings.read().map_err(|_| "设置繁忙")?.clone() };
    Ok(
        serde_json::json!({"version":app.package_info().version.to_string(),
        "settings":settings,
        "queue":state.downloads.snapshot(),"paths":{"data":state.data_root.to_string_lossy(),"downloads":state.root().to_string_lossy(),"cache":state.cache_root.to_string_lossy()}}),
    )
}
#[tauri::command]
pub async fn search_comics(
    state: App<'_>,
    keyword: String,
    page: u64,
    kind: String,
) -> Result<Page<Comic>, String> {
    api::search_page(
        state.client.search(&keyword, page.max(1), &kind).await?,
        page.max(1),
    )
}
#[tauri::command]
pub async fn get_comic(state: App<'_>, comic_id: String) -> Result<Comic, String> {
    let comic = api::comic_model(&state.client.comic(&comic_id).await?, &comic_id);
    state.db.save_comic(&comic)?;
    Ok(comic)
}
#[tauri::command]
pub async fn get_chapters(
    state: App<'_>,
    comic_id: String,
    page: u64,
) -> Result<Page<Chapter>, String> {
    api::chapter_page(
        state.client.chapters(&comic_id, page.max(1)).await?,
        page.max(1),
    )
}
#[tauri::command]
pub fn get_queue(state: App<'_>) -> QueueSnapshot {
    // 主动读取前把节流的待发进度刷出，避免界面短暂看到旧状态
    state.downloads.flush();
    state.downloads.snapshot()
}
#[tauri::command]
pub fn enqueue_downloads(
    state: App<'_>,
    items: Vec<DownloadRequest>,
) -> Result<QueueSnapshot, String> {
    state.downloads.enqueue(items)
}
#[tauri::command]
pub fn queue_action(
    state: App<'_>,
    action: String,
    id: Option<String>,
) -> Result<QueueSnapshot, String> {
    state.downloads.action(&action, id.as_deref())
}

#[tauri::command]
pub async fn get_library(state: App<'_>) -> Result<Vec<LibraryBook>, String> {
    let db = state.db.clone();
    let root = state.root();
    tauri::async_runtime::spawn_blocking(move || library::list(&db, &root))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn delete_downloads(
    state: App<'_>,
    comic_id: String,
    chapter_ids: Vec<String>,
) -> Result<usize, String> {
    if state.downloads.busy() || state.pdf.busy() {
        return Err("请先完成下载和导出任务后再删除文件".into());
    }
    let db = state.db.clone();
    let root = state.root();
    let ids = if chapter_ids.is_empty() {
        db.local_chapters(&root.to_string_lossy(), Some(&comic_id))?
            .into_iter()
            .map(|c| c.id)
            .collect()
    } else {
        chapter_ids
    };
    tauri::async_runtime::spawn_blocking(move || library::delete(&db, &root, &comic_id, &ids))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn export_pdf(
    state: App<'_>,
    comic_id: String,
    chapter_ids: Vec<String>,
) -> Result<Vec<PdfResult>, String> {
    if chapter_ids.is_empty() || chapter_ids.len() > 50 {
        return Err("请选择 1–50 个章节导出".into());
    }
    if state.downloads.busy() || state.pdf.busy() {
        return Err("请先完成下载任务后再导出 PDF".into());
    }
    let root = state.root();
    let password = state
        .settings
        .read()
        .map_err(|_| "设置繁忙")?
        .pdf_password
        .clone();
    let mut results = Vec::new();
    let root_id = root.to_string_lossy().into_owned();
    for id in chapter_ids {
        let db = state.db.clone();
        let rid = root_id.clone();
        let cid = comic_id.clone();
        let chapter =
            tauri::async_runtime::spawn_blocking(move || db.local_chapter(&rid, &cid, &id))
                .await
                .map_err(|e| e.to_string())??
                .ok_or("章节尚未下载")?;
        if !chapter.failed_pages.is_empty() || chapter.page_count < chapter.total as usize {
            return Err(format!(
                "章节「{}」仍有缺页，请先补齐后再导出",
                chapter.title
            ));
        }
        let result = state
            .pdf
            .export(
                root.clone(),
                PathBuf::from(&chapter.directory),
                password.clone(),
            )
            .await?;
        let mut chapter = chapter;
        chapter.pdf_path = Some(result.path.clone());
        let db = state.db.clone();
        let rid = root_id.clone();
        tauri::async_runtime::spawn_blocking(move || db.save_chapter(&rid, &chapter))
            .await
            .map_err(|e| e.to_string())??;
        results.push(result);
    }
    Ok(results)
}
#[tauri::command]
pub async fn retry_incomplete(state: App<'_>) -> Result<QueueSnapshot, String> {
    let root = state.root();
    let db = state.db.clone();
    let items =
        tauri::async_runtime::spawn_blocking(move || -> Result<Vec<DownloadRequest>, String> {
            let mut items = Vec::new();
            for book in library::list(&db, &root)? {
                for chapter in book.chapters.into_iter().filter(|c| !c.complete) {
                    items.push(DownloadRequest {
                        comic: book.comic.clone(),
                        chapter: Chapter {
                            id: chapter.id,
                            title: chapter.title,
                            index: chapter.index,
                            page_count: chapter.total,
                            updated_at: String::new(),
                        },
                    });
                }
            }
            Ok(items)
        })
        .await
        .map_err(|e| e.to_string())??;
    state.downloads.enqueue(items)
}
#[tauri::command]
pub async fn get_reader_pages(
    state: App<'_>,
    comic_id: String,
    chapter_id: String,
    local: bool,
) -> Result<serde_json::Value, String> {
    if local {
        let db = state.db.clone();
        let root = state.root();
        let files = tauri::async_runtime::spawn_blocking(move || {
            library::files(&db, &root, &comic_id, &chapter_id)
        })
        .await
        .map_err(|e| e.to_string())??;
        Ok(serde_json::json!({"count":files.len(),"urls":[]}))
    } else {
        let pages = state.client.pages(&comic_id, &chapter_id).await?;
        Ok(serde_json::json!({"count":pages.urls.len(),"urls":pages.urls}))
    }
}
#[tauri::command]
pub fn get_reading_progress(
    state: App<'_>,
    comic_id: String,
    local: bool,
) -> Result<Option<ReadingProgress>, String> {
    let root = if local {
        state.root().to_string_lossy().into_owned()
    } else {
        "online".into()
    };
    state.db.progress(&root, &comic_id)
}
#[tauri::command]
pub fn save_reading_progress(
    state: App<'_>,
    mut progress: ReadingProgress,
    local: bool,
) -> Result<(), String> {
    if progress.comic_id.is_empty() || progress.chapter_id.is_empty() || progress.page > 100000 {
        return Err("阅读进度无效".into());
    }
    progress.updated_at = chrono::Utc::now().timestamp_millis();
    let root = if local {
        state.root().to_string_lossy().into_owned()
    } else {
        "online".into()
    };
    state.db.save_progress(&root, &progress)
}
#[tauri::command]
pub fn get_subscriptions(state: App<'_>) -> Result<Vec<Subscription>, String> {
    state.db.subscriptions()
}
#[tauri::command]
pub fn set_subscription(
    state: App<'_>,
    comic: Comic,
    chapter_limit: u64,
) -> Result<Subscription, String> {
    if comic.id.is_empty() || !(1..=100).contains(&chapter_limit) {
        return Err("单次追更数量应为 1–100 章".into());
    }
    let existing = state
        .db
        .subscriptions()?
        .into_iter()
        .find(|s| s.comic.id == comic.id);
    let mut sub = existing.unwrap_or_else(|| {
        let done: BTreeSet<u64> = state
            .db
            .local_chapters(&state.root().to_string_lossy(), Some(&comic.id))
            .unwrap_or_default()
            .into_iter()
            .filter(|c| c.complete)
            .map(|c| c.index)
            .collect();
        let mut last = 0;
        while done.contains(&(last + 1)) {
            last += 1;
        }
        Subscription {
            comic: comic.clone(),
            last_chapter: last,
            chapter_limit,
            checked_at: None,
            error: None,
        }
    });
    sub.comic = comic;
    sub.chapter_limit = chapter_limit;
    state.db.save_subscription(&sub)?;
    Ok(sub)
}
#[tauri::command]
pub fn remove_subscription(state: App<'_>, comic_id: String) -> Result<(), String> {
    state.db.remove_subscription(&comic_id)
}
#[tauri::command]
pub async fn check_subscriptions(state: App<'_>) -> Result<serde_json::Value, String> {
    state.inner().check_subscriptions().await
}
fn apply_settings(state: &AppState, patch: serde_json::Value) -> Result<Settings, String> {
    let mut guard = state.settings.write().map_err(|_| "设置繁忙")?;
    let mut value = serde_json::to_value(&*guard).map_err(|e| e.to_string())?;
    for (key, item) in patch.as_object().ok_or("设置格式无效")? {
        if value.get(key).is_none() {
            return Err(format!("未知设置：{key}"));
        }
        value[key] = item.clone();
    }
    let mut next: Settings = serde_json::from_value(value).map_err(|_| "设置格式无效")?;
    next.validate()?;
    let old_root = guard.download_directory.clone();
    let mut rebound_from: Option<String> = None;
    if next.download_directory != old_root {
        if state.pdf.busy() || state.downloads.busy() {
            return Err("请先完成下载和 PDF 导出后再切换目录".into());
        }
        let path = PathBuf::from(&next.download_directory);
        if !state
            .allowed_directories
            .lock()
            .map_err(|_| "目录选择繁忙")?
            .contains(&path)
        {
            return Err("请使用目录选择按钮指定下载目录".into());
        }
        std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
        next.download_directory = std::fs::canonicalize(path)
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .into_owned();
        // 目录切换 = 数据跟着搬：把旧根下的漫画目录逐个移到新根，再重挂 DB 记录与绝对路径。
        // 同盘 rename 秒级完成，跨盘回退复制+删除；重名跳过并记日志。
        if !old_root.is_empty() {
            let count = state.db.count_local(&old_root).unwrap_or(0);
            if count > 0 {
                migrate_library_files(&old_root, &next.download_directory)?;
                log::info!("下载目录已切换，已迁移 {count} 条本地记录及对应文件");
            }
            state.db.rebind_root(&old_root, &next.download_directory)?;
            rebound_from = Some(old_root);
        }
    }
    // 只有代理相关字段变化才重建 reqwest Client，避免改个外观就断掉连接池
    let proxy_changed = next.effective_proxy() != guard.effective_proxy();
    if proxy_changed {
        state.client.set_proxy(next.effective_proxy())?;
    }
    if let Err(error) = state.db.save_settings(&next) {
        if proxy_changed {
            let _ = state.client.set_proxy(guard.effective_proxy());
        }
        if let Some(old_root) = rebound_from {
            let _ = state.db.rebind_root(&next.download_directory, &old_root);
        }
        return Err(error);
    }
    *guard = next.clone();
    Ok(next)
}
#[tauri::command]
pub fn update_settings(state: App<'_>, patch: serde_json::Value) -> Result<Settings, String> {
    let current = state
        .settings
        .read()
        .map_err(|_| "设置繁忙")?
        .download_directory
        .clone();
    let changing = patch
        .get("downloadDirectory")
        .is_some_and(|v| v.as_str() != Some(current.as_str()));
    if changing {
        state.downloads.when_idle(|| apply_settings(&state, patch))
    } else {
        apply_settings(&state, patch)
    }
}
#[tauri::command]
pub async fn pick_download_directory(
    app: tauri::AppHandle,
    state: App<'_>,
) -> Result<Option<String>, String> {
    let selected = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title("选择漫画下载目录")
            .blocking_pick_folder()
    })
    .await
    .map_err(|e| e.to_string())?;
    if let Some(path) = selected {
        let path = path.into_path().map_err(|e| e.to_string())?;
        state
            .allowed_directories
            .lock()
            .map_err(|_| "目录选择繁忙")?
            .insert(path.clone());
        Ok(Some(path.to_string_lossy().into_owned()))
    } else {
        Ok(None)
    }
}
#[tauri::command]
pub fn open_location(app: tauri::AppHandle, state: App<'_>, kind: String) -> Result<(), String> {
    let path = match kind.as_str() {
        "data" => state.data_root.clone(),
        "downloads" => state.root(),
        "cache" => state.cache_root.clone(),
        _ => return Err("目录类型无效".into()),
    };
    app.opener()
        .open_path(path.to_string_lossy().into_owned(), None::<&str>)
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub fn open_chapter(
    app: tauri::AppHandle,
    state: App<'_>,
    comic_id: String,
    chapter_id: String,
    pdf: bool,
) -> Result<(), String> {
    let root = state.root();
    let chapter = state
        .db
        .local_chapter(&root.to_string_lossy(), &comic_id, &chapter_id)?
        .ok_or("章节尚未下载")?;
    let path = if pdf {
        chapter.pdf_path.ok_or("该章节尚未导出 PDF")?
    } else {
        chapter.directory
    };
    let path = storage::inside(&root, Path::new(&path), false)?;
    app.opener()
        .open_path(path.to_string_lossy().into_owned(), None::<&str>)
        .map_err(|e| e.to_string())
}
/// 把旧下载根下的漫画目录搬到新根。只搬 DB 里登记的章节所在的顶级漫画目录，
/// 重名跳过（新目录已有同名内容时以新目录为准，不覆盖）。
fn migrate_library_files(old_root: &str, new_root: &str) -> Result<(), String> {
    let old = Path::new(old_root);
    let new = Path::new(new_root);
    let entries = std::fs::read_dir(old).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        if !entry.file_type().is_ok_and(|t| t.is_dir()) {
            continue;
        }
        let src = entry.path();
        let dest = new.join(entry.file_name());
        if dest.exists() {
            log::warn!("目标目录已存在，跳过迁移：{}", dest.display());
            continue;
        }
        if let Err(e) = std::fs::rename(&src, &dest) {
            // EXDEV：跨盘时退回复制+删除
            if e.raw_os_error() == Some(18) {
                std::fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
                copy_dir_all(&src, &dest)?;
                let _ = std::fs::remove_dir_all(&src);
            } else {
                return Err(format!("迁移目录失败：{e}"));
            }
        }
    }
    Ok(())
}
fn copy_dir_all(src: &Path, dest: &Path) -> Result<(), String> {
    for entry in std::fs::read_dir(src).map_err(|e| e.to_string())?.flatten() {
        let target = dest.join(entry.file_name());
        if entry.file_type().is_ok_and(|t| t.is_dir()) {
            std::fs::create_dir_all(&target).map_err(|e| e.to_string())?;
            copy_dir_all(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), &target).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn clear_image_cache(state: App<'_>) -> Result<(), String> {
    let path = state.cache_root.join("images");
    if path.is_dir() {
        tokio::fs::remove_dir_all(&path)
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}
