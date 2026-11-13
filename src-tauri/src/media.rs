use crate::{api, image_protocol, state::AppState, storage};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, OnceLock},
    time::{Duration, Instant},
};
use tauri::Manager;
fn response(status: u16, mime: &str, body: Vec<u8>) -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder()
        .status(status)
        .header("Content-Type", mime)
        // No wildcard ACAO: this protocol is only reachable from the app's own
        // webview, and a wildcard would let any origin read cached images.
        .header(
            "Cache-Control",
            if status == 200 {
                "private, max-age=3600"
            } else {
                "no-store"
            },
        )
        .body(body)
        .unwrap_or_else(|_| tauri::http::Response::new(Vec::new()))
}
fn mime(bytes: &[u8]) -> &'static str {
    match image::guess_format(bytes).ok() {
        Some(image::ImageFormat::Png) => "image/png",
        Some(image::ImageFormat::Jpeg) => "image/jpeg",
        Some(image::ImageFormat::WebP) => "image/webp",
        Some(image::ImageFormat::Gif) => "image/gif",
        Some(image::ImageFormat::Bmp) => "image/bmp",
        // Unknown bytes must not be advertised as a renderable image.
        _ => "application/octet-stream",
    }
}
fn limit() -> &'static tokio::sync::Semaphore {
    static LIMIT: OnceLock<tokio::sync::Semaphore> = OnceLock::new();
    LIMIT.get_or_init(|| tokio::sync::Semaphore::new(8))
}
/// Bookkeeping for the debounced, serialized cache eviction. A single lock
/// (`CacheState::io`) serializes cache writes, eviction scans and the counter
/// updates so concurrent requests never spawn overlapping full-directory
/// scans. `clear_image_cache` (commands.rs) cannot take this lock, but
/// `atomic_write` recreates missing parents, so a concurrent clear can never
/// corrupt or panic an in-flight write.
struct IoState {
    writes_since_scan: u32,
    last_scan: Option<Instant>,
}
/// Per-URL singleflight slot: the leader holds the mutex across the whole
/// fetch, stores the shared result in `Option`, and followers wake up and
/// clone it. Both successes and failures are shared (no thundering herd).
type Flight = tokio::sync::Mutex<Option<Result<Vec<u8>, ()>>>;
struct CacheState {
    io: tokio::sync::Mutex<IoState>,
    flights: tokio::sync::Mutex<HashMap<String, Arc<Flight>>>,
}
fn cache_state() -> &'static CacheState {
    static STATE: OnceLock<CacheState> = OnceLock::new();
    STATE.get_or_init(|| CacheState {
        io: tokio::sync::Mutex::new(IoState {
            writes_since_scan: 0,
            last_scan: None,
        }),
        flights: tokio::sync::Mutex::new(HashMap::new()),
    })
}
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalImage {
    comic_id: String,
    chapter_id: String,
    page: usize,
}
pub fn handle(
    app: tauri::AppHandle,
    request: tauri::http::Request<Vec<u8>>,
    responder: tauri::UriSchemeResponder,
) {
    let route = image_protocol::parse_image_uri(&request.uri().to_string());
    let Ok((kind, target)) = route else {
        responder.respond(response(400, "text/plain", b"bad image route".to_vec()));
        return;
    };
    tauri::async_runtime::spawn(async move {
        let state = app.state::<Arc<AppState>>().inner().clone();
        let bytes: Result<Vec<u8>, ()> = if kind == "local" {
            async {
                let image: LocalImage =
                    serde_json::from_str(&target).map_err(|_| ())?;
                let paths = crate::library::files(
                    &state.db,
                    &state.root(),
                    &image.comic_id,
                    &image.chapter_id,
                )
                .map_err(|_| ())?;
                let path = paths.get(image.page).ok_or(())?;
                let bytes = tokio::fs::read(path).await.map_err(|_| ())?;
                // Never serve arbitrary local bytes as an image.
                if !api::valid_image(&bytes) {
                    return Err(());
                }
                Ok(bytes)
            }
            .await
        } else {
            cached_remote(&state, &target).await
        };
        match bytes {
            Ok(bytes) => responder.respond(response(200, mime(&bytes), bytes)),
            Err(_) => responder.respond(response(404, "text/plain", b"image unavailable".to_vec())),
        }
    });
}
async fn read_valid_cache(path: &Path) -> Option<Vec<u8>> {
    let bytes = tokio::fs::read(path).await.ok()?;
    api::valid_image(&bytes).then_some(bytes)
}
async fn cached_remote(state: &Arc<AppState>, target: &str) -> Result<Vec<u8>, ()> {
    state.client.validate_image_url(target).map_err(|_| ())?;
    use sha2::{Digest, Sha256};
    let hash = hex::encode(Sha256::digest(target.as_bytes()));
    let cache = state.cache_root.join("images").join(&hash[..2]).join(&hash);
    if let Some(bytes) = read_valid_cache(&cache).await {
        return Ok(bytes);
    }
    // Singleflight: only one in-flight network fetch per URL hash.
    let flight = {
        let mut flights = cache_state().flights.lock().await;
        flights
            .entry(hash.clone())
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(None)))
            .clone()
    };
    let mut slot = flight.lock().await;
    if let Some(result) = slot.as_ref() {
        return result.clone();
    }
    // We are the leader. Keep `slot` held for the whole fetch so followers
    // block, then share the result with everyone.
    let result = fetch_and_store(state, target, &cache).await;
    *slot = Some(result.clone());
    {
        let mut flights = cache_state().flights.lock().await;
        flights.remove(&hash);
    }
    result
}
async fn fetch_and_store(
    state: &Arc<AppState>,
    target: &str,
    cache: &Path,
) -> Result<Vec<u8>, ()> {
    let _permit = limit().acquire().await.map_err(|_| ())?;
    let bytes = state.client.image(target).await.map_err(|_| ())?;
    if bytes.len() <= 8 * 1024 * 1024 {
        write_and_maybe_evict(state, cache, &bytes).await;
    }
    Ok(bytes)
}
async fn write_and_maybe_evict(state: &Arc<AppState>, cache: &Path, bytes: &[u8]) {
    // One lock serializes this write, any concurrent eviction, and the
    // debounce counters.
    let mut io = cache_state().io.lock().await;
    let path = cache.to_path_buf();
    let save = bytes.to_vec();
    let _ = tauri::async_runtime::spawn_blocking(move || storage::atomic_write(&path, &save)).await;
    io.writes_since_scan = io.writes_since_scan.saturating_add(1);
    let due = io.writes_since_scan >= 32
        || io
            .last_scan
            .is_none_or(|t| t.elapsed() > Duration::from_secs(5));
    if due {
        let root = state.cache_root.join("images");
        let cap = state
            .settings
            .read()
            .map(|s| s.image_cache_limit_mb * 1024 * 1024)
            .unwrap_or(256 * 1024 * 1024);
        let _ = tauri::async_runtime::spawn_blocking(move || evict(root, cap)).await;
        io.writes_since_scan = 0;
        io.last_scan = Some(Instant::now());
    }
}
fn evict(root: PathBuf, limit: u64) {
    let mut files = Vec::new();
    let mut total = 0;
    if let Ok(dirs) = std::fs::read_dir(root) {
        for dir in dirs.flatten() {
            if let Ok(entries) = std::fs::read_dir(dir.path()) {
                for file in entries.flatten() {
                    if let Ok(meta) = file.metadata() {
                        if meta.is_file() {
                            total += meta.len();
                            files.push((meta.modified().ok(), meta.len(), file.path()));
                        }
                    }
                }
            }
        }
    }
    if total <= limit {
        return;
    }
    files.sort_by_key(|f| f.0);
    for (_, size, path) in files {
        if total <= limit * 9 / 10 {
            break;
        }
        if std::fs::remove_file(path).is_ok() {
            total = total.saturating_sub(size);
        }
    }
}
