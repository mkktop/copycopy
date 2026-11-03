use crate::{
    api::{self, MangaClient},
    db::Database,
    download::DownloadManager,
    models::*,
    pdf::PdfManager,
};
use std::{
    collections::HashSet,
    path::PathBuf,
    sync::{
        Arc, Mutex, RwLock,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tauri::{Emitter, Manager};
use tauri_plugin_notification::NotificationExt;

pub struct AppState {
    pub db: Arc<Database>,
    pub client: MangaClient,
    pub settings: Arc<RwLock<Settings>>,
    pub downloads: Arc<DownloadManager>,
    pub pdf: Arc<PdfManager>,
    pub data_root: PathBuf,
    pub cache_root: PathBuf,
    pub allowed_directories: Mutex<HashSet<PathBuf>>,
    checking_subscriptions: AtomicBool,
}
impl AppState {
    pub fn initialize(app: tauri::AppHandle) -> Result<Arc<Self>, String> {
        let data_root = std::env::var_os("COPYCOPY_DATA_DIR")
            .map(PathBuf::from)
            .unwrap_or(app.path().app_data_dir().map_err(|e| e.to_string())?);
        let cache_root = data_root.join("cache");
        std::fs::create_dir_all(&cache_root).map_err(|e| e.to_string())?;
        let db = Arc::new(Database::open(&data_root.join("copycopy.sqlite"))?);
        let mut settings = db.settings()?;
        if settings.download_directory.is_empty() {
            settings.download_directory = data_root.join("library").to_string_lossy().into_owned();
        }
        settings.validate()?;
        std::fs::create_dir_all(&settings.download_directory).map_err(|e| e.to_string())?;
        settings.download_directory = std::fs::canonicalize(&settings.download_directory)
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .into_owned();
        db.save_settings(&settings)?;
        let client = MangaClient::new(settings.effective_proxy())?;
        let settings = Arc::new(RwLock::new(settings));
        let pdf = Arc::new(PdfManager::new());
        let previously_busy = Arc::new(AtomicBool::new(false));
        let baseline = Arc::new(Mutex::new(0usize));
        let event_app = app.clone();
        let event_settings = settings.clone();
        let sink = Arc::new(move |snapshot: QueueSnapshot| {
            let busy = snapshot
                .tasks
                .iter()
                .any(|t| t.status == "pending" || t.status == "running");
            let finished = snapshot
                .tasks
                .iter()
                .filter(|t| t.status == "done" || t.status == "failed")
                .count();
            let was_busy = previously_busy.swap(busy, Ordering::SeqCst);
            if busy && !was_busy {
                *baseline.lock().unwrap_or_else(|e| e.into_inner()) = finished;
            }
            if was_busy
                && !busy
                && finished > *baseline.lock().unwrap_or_else(|e| e.into_inner())
                && event_settings.read().is_ok_and(|s| s.notify_on_done)
            {
                let _ = event_app
                    .notification()
                    .builder()
                    .title("CopyCopy")
                    .body("下载队列已结束，可前往本地书库查看。")
                    .show();
            }
            let _ = event_app.emit("queue-update", snapshot);
        });
        let downloads = DownloadManager::new(
            db.clone(),
            client.clone(),
            settings.clone(),
            pdf.clone(),
            sink,
        )?;
        Ok(Arc::new(Self {
            db,
            client,
            settings,
            downloads,
            pdf,
            data_root,
            cache_root,
            allowed_directories: Mutex::new(HashSet::new()),
            checking_subscriptions: AtomicBool::new(false),
        }))
    }
    pub fn root(&self) -> PathBuf {
        PathBuf::from(
            &self
                .settings
                .read()
                .unwrap_or_else(|e| e.into_inner())
                .download_directory,
        )
    }
    pub async fn check_subscriptions(self: &Arc<Self>) -> Result<serde_json::Value, String> {
        if self.checking_subscriptions.swap(true, Ordering::SeqCst) {
            return Err("订阅检查正在进行".into());
        }
        struct Guard<'a>(&'a AtomicBool);
        impl Drop for Guard<'_> {
            fn drop(&mut self) {
                self.0.store(false, Ordering::SeqCst);
            }
        }
        let _guard = Guard(&self.checking_subscriptions);
        if self.downloads.busy() {
            return Err("请等待当前下载完成后再检查追更".into());
        }
        let mut checked = 0;
        let mut requests = Vec::new();
        let mut errors = Vec::new();
        for mut sub in self.db.subscriptions()? {
            let result = async {
                let first = api::chapter_page(self.client.chapters(&sub.comic.id, 1).await?, 1)?;
                let from = sub.last_chapter + 1;
                let last = first.total.min(sub.last_chapter + sub.chapter_limit);
                if from <= last {
                    for page in ((from - 1) / 50 + 1)..=((last - 1) / 50 + 1) {
                        let data = if page == 1 {
                            first.clone()
                        } else {
                            api::chapter_page(
                                self.client.chapters(&sub.comic.id, page).await?,
                                page,
                            )?
                        };
                        for chapter in data
                            .items
                            .into_iter()
                            .filter(|c| c.index >= from && c.index <= last)
                        {
                            requests.push(DownloadRequest {
                                comic: sub.comic.clone(),
                                chapter,
                            });
                        }
                    }
                }
                Ok::<(), String>(())
            }
            .await;
            sub.checked_at = Some(chrono::Utc::now().timestamp_millis());
            match result {
                Ok(()) => {
                    checked += 1;
                    sub.error = None;
                }
                Err(error) => {
                    errors.push(format!("{}：{}", sub.comic.title, error));
                    sub.error = Some(error);
                }
            }
            self.db.save_subscription(&sub)?;
        }
        let queued = requests.len();
        if queued > 0 {
            self.downloads.enqueue(requests)?;
        }
        Ok(serde_json::json!({"checked":checked,"queued":queued,"errors":errors}))
    }
    pub fn start_background(self: &Arc<Self>) {
        self.downloads.start();
        let state = self.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_secs(3)).await;
            let startup = state
                .settings
                .read()
                .is_ok_and(|s| s.check_subscriptions_on_launch);
            if startup && !state.downloads.busy() {
                let _ = state.check_subscriptions().await;
            }
            let mut previous = std::time::Instant::now();
            loop {
                tokio::time::sleep(Duration::from_secs(30)).await;
                let interval = state
                    .settings
                    .read()
                    .map(|s| s.subscription_interval_hours)
                    .unwrap_or(0);
                if interval > 0
                    && previous.elapsed().as_secs() >= interval * 3600
                    && !state.downloads.busy()
                {
                    let _ = state.check_subscriptions().await;
                    previous = std::time::Instant::now();
                }
            }
        });
    }
}
