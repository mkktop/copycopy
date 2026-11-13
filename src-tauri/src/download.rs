use crate::{
    api::{self, MangaClient},
    db::Database,
    library,
    models::*,
    pdf::PdfManager,
    storage,
};
use futures::{StreamExt, stream};
use std::{
    collections::{BTreeSet, HashMap},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex, RwLock,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;

/// 裁剪已结束任务，区分 canceled：优先淘汰最旧的 done/failed，保留 canceled 供重试
fn trim_finished(tasks: &mut Vec<DownloadTask>) {
    let finished = tasks
        .iter()
        .filter(|t| !["pending", "running"].contains(&t.status.as_str()))
        .count();
    if finished <= FINISHED_LIMIT {
        return;
    }
    // 先淘汰 done/failed（最旧的在前），canceled 尽量保留
    let mut excess = finished - FINISHED_LIMIT;
    tasks.retain(|t| {
        if excess == 0 || ["pending", "running"].contains(&t.status.as_str()) {
            return true;
        }
        if t.status == "canceled" {
            return true;
        }
        excess -= 1;
        false
    });
    // 若 canceled 仍然过多，再按最旧顺序淘汰
    if excess > 0 {
        tasks.retain(|t| {
            if excess == 0 || ["pending", "running"].contains(&t.status.as_str()) {
                return true;
            }
            excess -= 1;
            false
        });
    }
}

/// 单次入队上限（订阅检查/补齐等批量调用会自动分批，不再整体拒绝）
const ENQUEUE_BATCH: usize = 500;
/// 活跃（pending+running）任务上限
const ACTIVE_LIMIT: usize = 1000;
/// 已结束任务保留上限
const FINISHED_LIMIT: usize = 500;
/// 进度事件最小间隔：同一任务的页完成事件在此窗口内合并，避免每页一次全量广播
const THROTTLE: Duration = Duration::from_millis(100);

type Sink = Arc<dyn Fn(QueueEvent) + Send + Sync>;
pub struct DownloadManager {
    queue: Mutex<QueueSnapshot>,
    active: AtomicBool,
    tokens: Mutex<HashMap<String, CancellationToken>>,
    pub db: Arc<Database>,
    client: MangaClient,
    settings: Arc<RwLock<Settings>>,
    pdf: Arc<PdfManager>,
    sink: Sink,
    /// 节流状态：记录最后一次广播时间与是否有待广播的变更
    throttle: Mutex<ThrottleState>,
}
struct ThrottleState {
    last: Instant,
    /// 窗口内累积的变更任务（按 id 覆盖），flush 时决定发 Delta 还是 Full
    pending: HashMap<String, DownloadTask>,
}
impl DownloadManager {
    pub fn new(
        db: Arc<Database>,
        client: MangaClient,
        settings: Arc<RwLock<Settings>>,
        pdf: Arc<PdfManager>,
        sink: Sink,
    ) -> Result<Arc<Self>, String> {
        let mut tasks = db.queue()?;
        for task in &mut tasks {
            if task.status == "running" {
                task.status = "pending".into();
                task.error = None;
            }
        }
        db.save_queue(&tasks)?;
        let manager = Arc::new(Self {
            queue: Mutex::new(QueueSnapshot { revision: 0, tasks }),
            active: AtomicBool::new(false),
            tokens: Mutex::new(HashMap::new()),
            db,
            client,
            settings,
            pdf,
            sink,
            throttle: Mutex::new(ThrottleState {
                last: Instant::now() - THROTTLE,
                pending: HashMap::new(),
            }),
        });
        Ok(manager)
    }
    pub fn snapshot(&self) -> QueueSnapshot {
        self.queue.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
    pub fn busy(&self) -> bool {
        self.active.load(Ordering::SeqCst)
            || self
                .snapshot()
                .tasks
                .iter()
                .any(|t| t.status == "pending" || t.status == "running")
    }
    pub fn when_idle<T>(&self, job: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
        let queue = self.queue.lock().map_err(|_| "下载队列繁忙")?;
        if self.active.load(Ordering::SeqCst)
            || queue
                .tasks
                .iter()
                .any(|t| t.status == "pending" || t.status == "running")
        {
            return Err("请先完成下载任务".into());
        }
        job()
    }
    /// 立即广播完整快照（状态变更用），并清掉待发增量避免重复。
    fn publish_full(&self, snapshot: QueueSnapshot) {
        self.throttle
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .pending
            .clear();
        (self.sink)(QueueEvent::Full(snapshot));
    }
    /// 高频进度：把变更任务累积到节流窗口，返回是否应立即刷出。
    fn publish_delta(&self, task: DownloadTask) -> bool {
        let mut state = self.throttle.lock().unwrap_or_else(|e| e.into_inner());
        state.pending.insert(task.id.clone(), task);
        state.last.elapsed() >= THROTTLE
    }
    /// 刷出累积的增量：单个发 Delta，多个发 Full（前端两种都兼容）。
    fn flush_pending(&self) {
        let pending = {
            let mut state = self.throttle.lock().unwrap_or_else(|e| e.into_inner());
            if state.pending.is_empty() {
                return;
            }
            state.last = Instant::now();
            std::mem::take(&mut state.pending)
        };
        let revision = self.snapshot().revision;
        if pending.len() == 1 {
            let task = pending.into_values().next().unwrap();
            (self.sink)(QueueEvent::Delta { revision, task });
        } else {
            (self.sink)(QueueEvent::Full(QueueSnapshot {
                revision,
                tasks: self.snapshot().tasks,
            }));
        }
    }
    /// 延迟刷出：异步等待节流窗口，把合并后的事件送出去。
    fn schedule_flush(self: &Arc<Self>, delay: Duration) {
        let this = self.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(delay).await;
            this.flush_pending();
        });
    }
    /// 供外部（如 get_queue）在读快照前把待发事件刷出，避免界面看到旧状态。
    pub fn flush(&self) {
        self.flush_pending();
    }
    /// 更新单个任务。DB 写入走 spawn_blocking，避免同步 rusqlite 占住 tokio worker；
    /// 进度事件走节流增量（只发变更任务），不再每页广播整份队列。
    async fn update(
        self: &Arc<Self>,
        id: &str,
        change: impl FnOnce(&mut DownloadTask) + Send + 'static,
    ) -> Result<(), String> {
        let changed = {
            let mut queue = self.queue.lock().map_err(|_| "下载队列繁忙")?;
            let mut saved: Option<(usize, DownloadTask)> = None;
            if let Some((index, task)) =
                queue.tasks.iter_mut().enumerate().find(|(_, t)| t.id == id)
            {
                change(task);
                saved = Some((index, task.clone()));
            }
            queue.revision += 1;
            saved
        };
        if let Some((index, task)) = changed {
            let db = self.db.clone();
            let stored = task.clone();
            tauri::async_runtime::spawn_blocking(move || db.save_task(&stored, index))
                .await
                .map_err(|e| e.to_string())??;
            let due = self.publish_delta(task);
            if !due {
                self.schedule_flush(THROTTLE);
            }
        }
        Ok(())
    }
    /// 入队。批量超过 ENQUEUE_BATCH 时自动分批，绝不因单次批量过大而整体拒绝。
    /// 先把整批校验完、构建好任务列表，再一次性写内存与 DB，避免中途失败留下"内存有、DB 无"的半状态。
    pub fn enqueue(self: &Arc<Self>, items: Vec<DownloadRequest>) -> Result<QueueSnapshot, String> {
        // 前置校验：整批必须合法，否则一条都不入队
        for item in &items {
            if item.comic.id.is_empty() || item.chapter.id.is_empty() {
                return Err("漫画或章节标识无效".into());
            }
        }
        let root = PathBuf::from(
            &self
                .settings
                .read()
                .map_err(|_| "设置繁忙")?
                .download_directory,
        );
        // 目录创建与 comic 落库放在锁外，且允许失败时提前返回（尚未改动队列）
        let mut prepared: Vec<(DownloadRequest, String)> = Vec::with_capacity(items.len());
        for item in items {
            let dir = library::chapter_directory(&root, &item.comic, &item.chapter)?;
            self.db.save_comic(&item.comic)?;
            prepared.push((item, dir.to_string_lossy().into_owned()));
        }
        // 分批：每批独立检查活跃上限，超限时明确报错但不影响已成功的批次
        for chunk in prepared.chunks(ENQUEUE_BATCH) {
            self.enqueue_chunk(chunk)?;
        }
        self.start();
        Ok(self.snapshot())
    }
    fn enqueue_chunk(
        self: &Arc<Self>,
        chunk: &[(DownloadRequest, String)],
    ) -> Result<(), String> {
        let snapshot = {
            let mut queue = self.queue.lock().map_err(|_| "下载队列繁忙")?;
            let active = queue
                .tasks
                .iter()
                .filter(|t| t.status == "pending" || t.status == "running")
                .count();
            if active + chunk.len() > ACTIVE_LIMIT {
                return Err("队列已满，请完成部分任务后再添加".into());
            }
            for (item, dir) in chunk {
                if queue.tasks.iter().any(|t| {
                    t.comic.id == item.comic.id
                        && t.chapter.id == item.chapter.id
                        && (t.status == "pending" || t.status == "running")
                }) {
                    continue;
                }
                queue.tasks.push(DownloadTask {
                    id: uuid::Uuid::new_v4().to_string(),
                    comic: item.comic.clone(),
                    chapter: item.chapter.clone(),
                    directory: dir.clone(),
                    status: "pending".into(),
                    ..Default::default()
                });
            }
            trim_finished(&mut queue.tasks);
            queue.revision += 1;
            self.db.save_queue(&queue.tasks)?;
            queue.clone()
        };
        self.publish_full(snapshot);
        Ok(())
    }
    pub fn action(
        self: &Arc<Self>,
        action: &str,
        id: Option<&str>,
    ) -> Result<QueueSnapshot, String> {
        let snapshot = {
            let mut queue = self.queue.lock().map_err(|_| "下载队列繁忙")?;
            match action {
                "cancel" | "cancelAll" => {
                    for task in &mut queue.tasks {
                        if (action == "cancelAll" || Some(task.id.as_str()) == id)
                            && ["pending", "running"].contains(&task.status.as_str())
                        {
                            if let Some(token) = self
                                .tokens
                                .lock()
                                .map_err(|_| "下载队列繁忙")?
                                .get(&task.id)
                            {
                                token.cancel();
                            }
                            task.status = "canceled".into();
                            task.finished_at = Some(chrono::Utc::now().timestamp_millis());
                        }
                    }
                }
                "retry" | "retryFailed" => {
                    for task in &mut queue.tasks {
                        if (action == "retryFailed" && task.status == "failed"
                            || action == "retry" && Some(task.id.as_str()) == id)
                            && ["failed", "canceled"].contains(&task.status.as_str())
                        {
                            task.status = "pending".into();
                            task.error = None;
                            task.failed_pages.clear();
                            task.finished_at = None;
                        }
                    }
                }
                "clearFinished" => queue
                    .tasks
                    .retain(|t| ["pending", "running"].contains(&t.status.as_str())),
                "moveTop" => {
                    if let Some(i) = queue
                        .tasks
                        .iter()
                        .position(|t| Some(t.id.as_str()) == id && t.status == "pending")
                    {
                        let task = queue.tasks.remove(i);
                        queue.tasks.insert(0, task);
                    }
                }
                _ => return Err("不支持的队列操作".into()),
            }
            queue.revision += 1;
            self.db.save_queue(&queue.tasks)?;
            queue.clone()
        };
        self.publish_full(snapshot.clone());
        self.start();
        Ok(snapshot)
    }
    pub fn start(self: &Arc<Self>) {
        if self.active.swap(true, Ordering::SeqCst) {
            return;
        }
        let this = self.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                let next = {
                    let queue = this.queue.lock().unwrap_or_else(|e| e.into_inner());
                    let next = queue.tasks.iter().find(|t| t.status == "pending").cloned();
                    if next.is_none() {
                        this.active.store(false, Ordering::SeqCst);
                    }
                    next
                };
                let Some(task) = next else {
                    // 队列转空闲：发一次完整快照，供通知统计与前端最终对账
                    this.flush_pending();
                    this.publish_full(this.snapshot());
                    break;
                };
                let token = CancellationToken::new();
                this.tokens
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .insert(task.id.clone(), token.clone());
                if let Err(error) = this.process(task.clone(), token.clone()).await {
                    let _ = this
                        .update(&task.id, move |t| {
                            if t.status != "canceled" {
                                t.status = "failed".into();
                                t.error = Some(error);
                                t.finished_at = Some(chrono::Utc::now().timestamp_millis());
                            }
                        })
                        .await;
                }
                // 章节收尾后把节流的待发事件立即刷出，保证 UI 看到最终状态
                this.flush_pending();
                this.tokens
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .remove(&task.id);
                let config = this
                    .settings
                    .read()
                    .unwrap_or_else(|e| e.into_inner())
                    .clone();
                let range = config
                    .chapter_delay_max
                    .saturating_sub(config.chapter_delay_min);
                let extra = if range == 0 {
                    0
                } else {
                    chrono::Utc::now().timestamp_subsec_millis() as u64 % (range + 1)
                };
                let delay = config.chapter_delay_min + extra;
                if this.snapshot().tasks.iter().any(|t| t.status == "pending") {
                    for _ in 0..delay * 5 {
                        if token.is_cancelled() {
                            break;
                        }
                        tokio::time::sleep(Duration::from_millis(200)).await;
                    }
                }
            }
        });
    }
    async fn process(
        self: &Arc<Self>,
        task: DownloadTask,
        token: CancellationToken,
    ) -> Result<(), String> {
        self.update(&task.id, |t| {
            if t.status != "canceled" {
                t.status = "running".into();
                t.completed = 0;
                t.skipped = 0;
                t.failed_pages.clear();
                t.error = None;
                t.started_at = Some(chrono::Utc::now().timestamp_millis());
            }
        })
        .await?;
        if token.is_cancelled()
            || self
                .snapshot()
                .tasks
                .iter()
                .find(|t| t.id == task.id)
                .is_some_and(|t| t.status == "canceled")
        {
            return Ok(());
        }
        let settings = self.settings.read().map_err(|_| "设置繁忙")?.clone();
        let root = PathBuf::from(&settings.download_directory);
        let dir = storage::inside(&root, Path::new(&task.directory), false)?;
        let pages = tokio::select! {_=token.cancelled()=>return Ok(()),result=self.client.pages(&task.comic.id,&task.chapter.id)=>result?};
        let total = pages.urls.len() as u64;
        self.update(&task.id, move |t| t.total = total).await?;

        // 页序指纹：把本轮 URL 顺序写入章节目录（.copycopy.pages）。
        // 续下时若指纹变了（站点重排 words），清空该章已有图片重下，避免旧页被当作新序号复用导致错页。
        let fingerprint = page_fingerprint(&pages.urls);
        let marker = dir.join(".copycopy.pages");
        if let Ok(previous) = tokio::fs::read(&marker).await {
            if previous != fingerprint.as_bytes() {
                if let Ok(mut entries) = tokio::fs::read_dir(&dir).await {
                    while let Ok(Some(entry)) = entries.next_entry().await {
                        let p = entry.path();
                        if p.is_file()
                            && p.extension().is_some_and(|e| {
                                ["jpg", "jpeg", "png", "webp", "gif", "bmp"]
                                    .contains(&e.to_string_lossy().to_ascii_lowercase().as_str())
                            })
                        {
                            let _ = tokio::fs::remove_file(p).await;
                        }
                    }
                }
            }
        }
        let _ = tokio::fs::write(&marker, fingerprint.as_bytes()).await;

        // 页下载按当前设置分批并发；每批结束重读一次设置，运行中调整并发度下一批即生效。
        let urls = pages.urls;
        let mut start = 0usize;
        while start < urls.len() && !token.is_cancelled() {
            let limit = self
                .settings
                .read()
                .map(|s| s.parallel_images.max(1).min(16))
                .unwrap_or(5);
            let end = (start + limit).min(urls.len());
            let this = self.clone();
            let task_id = task.id.clone();
            let token_for_pages = token.clone();
            let dir = dir.clone();
            let batch: Vec<_> = urls[start..end]
                .iter()
                .enumerate()
                .map(|(i, url)| (start + i, url.clone()))
                .collect();
            stream::iter(batch)
                .for_each_concurrent(limit, move |(index, url)| {
                    let this = this.clone();
                    let id = task_id.clone();
                    let token = token_for_pages.clone();
                    let path = dir.join(format!("{:04}.jpg", index + 1));
                    async move {
                        if token.is_cancelled() {
                            return;
                        }
                        let result = this.download_page(&url, &path, &token).await;
                        if token.is_cancelled() {
                            return;
                        }
                        let _ = this
                            .update(&id, move |task| match result {
                                Ok(true) => task.skipped += 1,
                                Ok(false) => task.completed += 1,
                                Err(_) => task.failed_pages.push(index as u64 + 1),
                            })
                            .await;
                    }
                })
                .await;
            start = end;
        }

        // 取消也要落库：已下载的页必须能在书库里看到、可补齐/删除，订阅推进按实际完成数判断。
        let canceled = token.is_cancelled();
        let current = self
            .snapshot()
            .tasks
            .into_iter()
            .find(|t| t.id == task.id)
            .ok_or("下载任务已移除")?;
        let root_id = root.to_string_lossy().into_owned();
        // 保留已有的 pdf_path：重新下载/取消不该抹掉用户手动导出的 PDF
        let existing_pdf = {
            let db = self.db.clone();
            let rid = root_id.clone();
            let cid = task.comic.id.clone();
            let chid = task.chapter.id.clone();
            tauri::async_runtime::spawn_blocking(move || db.local_chapter(&rid, &cid, &chid))
                .await
                .map_err(|e| e.to_string())??
                .and_then(|c| c.pdf_path)
                .filter(|p| storage::inside(&root, Path::new(p), false).is_ok())
        };
        // 取消时按磁盘实际缺页计算 failed_pages：已落盘的页不算失败，补齐时只重下缺的页。
        let mut failed = current.failed_pages.clone();
        let mut page_count = (current.completed + current.skipped) as usize;
        if canceled {
            failed.clear();
            page_count = 0;
            if let Ok(mut entries) = tokio::fs::read_dir(&dir).await {
                let mut present = std::collections::BTreeSet::new();
                while let Ok(Some(entry)) = entries.next_entry().await {
                    let p = entry.path();
                    let stem = p.file_stem().unwrap_or_default().to_string_lossy();
                    if let Ok(n) = stem.parse::<u64>() {
                        if p.is_file()
                            && p.extension().is_some_and(|e| {
                                ["jpg", "jpeg", "png", "webp", "gif", "bmp"]
                                    .contains(&e.to_string_lossy().to_ascii_lowercase().as_str())
                            })
                        {
                            present.insert(n);
                        }
                    }
                }
                page_count = present.len();
                for n in 1..=total {
                    if !present.contains(&n) {
                        failed.push(n);
                    }
                }
            }
        }
        let mut chapter = LocalChapter {
            id: task.chapter.id.clone(),
            comic_id: task.comic.id.clone(),
            title: task.chapter.title.clone(),
            index: task.chapter.index,
            directory: task.directory.clone(),
            total,
            page_count,
            complete: !canceled && failed.is_empty() && page_count >= total as usize,
            failed_pages: failed,
            pdf_path: existing_pdf,
        };
        if !canceled && chapter.complete && settings.export_pdf_after_download {
            self.update(&task.id, |t| t.error = Some("正在生成 PDF…".into())).await?;
            match self
                .pdf
                .export(
                    root.clone(),
                    PathBuf::from(&task.directory),
                    settings.pdf_password,
                )
                .await
            {
                Ok(result) => {
                    chapter.pdf_path = Some(result.path);
                    self.update(&task.id, |t| t.error = None).await?;
                }
                Err(error) => {
                    self.update(&task.id, move |t| {
                        t.error = Some(format!("图片已下载，PDF 导出失败：{error}"))
                    })
                    .await?;
                }
            }
        }
        // 落库与订阅推进放 spawn_blocking，避免同步 rusqlite 阻塞 tokio worker
        {
            let db = self.db.clone();
            let rid = root_id.clone();
            let chapter = chapter.clone();
            tauri::async_runtime::spawn_blocking(move || db.save_chapter(&rid, &chapter))
                .await
                .map_err(|e| e.to_string())??;
        }
        if chapter.complete && !canceled {
            let db = self.db.clone();
            let rid = root_id.clone();
            let comic_id = task.comic.id.clone();
            tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
                let done: BTreeSet<u64> = db
                    .local_chapters(&rid, Some(&comic_id))?
                    .into_iter()
                    .filter(|c| c.complete)
                    .map(|c| c.index)
                    .collect();
                if let Some(mut sub) = db
                    .subscriptions()?
                    .into_iter()
                    .find(|s| s.comic.id == comic_id)
                {
                    while done.contains(&(sub.last_chapter + 1)) {
                        sub.last_chapter += 1;
                    }
                    db.save_subscription(&sub)?;
                }
                Ok(())
            })
            .await
            .map_err(|e| e.to_string())??;
        }
        let status = if canceled {
            "canceled"
        } else if chapter.complete {
            "done"
        } else {
            "failed"
        };
        let error = if canceled {
            Some("下载已取消，已下载的页可在书库中继续补齐".to_string())
        } else if !chapter.complete {
            Some(format!("有 {} 页下载失败，可重试补齐", chapter.failed_pages.len()))
        } else {
            None
        };
        self.update(&task.id, move |t| {
            if canceled {
                // 取消时保留 canceled 状态（action 已写入），只补完成信息
                t.status = "canceled".into();
            } else {
                t.status = status.into();
            }
            t.error = error;
            t.finished_at = Some(chrono::Utc::now().timestamp_millis());
        })
        .await?;
        Ok(())
    }
    async fn download_page(
        &self,
        url: &str,
        path: &Path,
        token: &CancellationToken,
    ) -> Result<bool, String> {
        for extension in ["jpg", "png", "webp", "gif", "bmp"] {
            if let Ok(bytes) = tokio::fs::read(path.with_extension(extension)).await {
                if api::valid_image(&bytes) {
                    return Ok(true);
                }
            }
        }
        for attempt in 0..3 {
            let result = tokio::select! {_=token.cancelled()=>return Err("已取消".into()),result=self.client.image(url)=>result};
            if let Ok(bytes) = result {
                let extension = match image::guess_format(&bytes).ok() {
                    Some(image::ImageFormat::Png) => "png",
                    Some(image::ImageFormat::WebP) => "webp",
                    Some(image::ImageFormat::Gif) => "gif",
                    Some(image::ImageFormat::Bmp) => "bmp",
                    _ => "jpg",
                };
                let path = path.with_extension(extension);
                tokio::task::spawn_blocking(move || storage::atomic_write(&path, &bytes))
                    .await
                    .map_err(|e| e.to_string())??;
                return Ok(false);
            }
            if attempt < 2 {
                tokio::select! {_=token.cancelled()=>return Err("已取消".into()),_=tokio::time::sleep(Duration::from_millis(400*(attempt+1)))=>{}}
            }
        }
        Err("图片下载失败".into())
    }
}

/// 用页 URL 顺序生成指纹，用于站点重排 words 后让续下失效（避免旧页错序复用）。
fn page_fingerprint(urls: &[String]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    for url in urls {
        hasher.update(url.as_bytes());
        hasher.update([0u8]);
    }
    hex::encode(hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::{
        Mock, MockServer, ResponseTemplate,
        matchers::{method, path},
    };
    async fn wait(manager: &DownloadManager) {
        for _ in 0..300 {
            if !manager.busy() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("queue did not finish");
    }
    #[tokio::test]
    async fn downloads_in_words_order_resumes_and_exports_complete_pdf() {
        let server = MockServer::start().await;
        Mock::given(method("GET")).and(path("/api/v3/comic/test/chapter2/ch1")).respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"code":200,"results":{"chapter":{"contents":[{"url":"/2.jpg"},{"url":"/1.jpg"}],"words":[1,0]},"comic":{"name":"test"}}}))).mount(&server).await;
        for (index, width) in [(1, 101), (2, 102)] {
            let mut bytes = Vec::new();
            let image = image::RgbImage::from_pixel(width, 180, image::Rgb([100, 120, 130]));
            if index == 1 {
                image::codecs::jpeg::JpegEncoder::new(&mut bytes)
                    .encode_image(&image)
                    .unwrap();
            } else {
                image
                    .write_to(
                        &mut std::io::Cursor::new(&mut bytes),
                        image::ImageFormat::Png,
                    )
                    .unwrap();
            }
            Mock::given(method("GET"))
                .and(path(format!("/{index}.jpg")))
                .respond_with(ResponseTemplate::new(200).set_body_bytes(bytes))
                .mount(&server)
                .await;
        }
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("books");
        std::fs::create_dir(&root).unwrap();
        let settings = Settings {
            download_directory: root.to_string_lossy().into_owned(),
            chapter_delay_min: 0,
            chapter_delay_max: 0,
            export_pdf_after_download: true,
            ..Default::default()
        };
        let db = Arc::new(Database::open(&temp.path().join("db.sqlite")).unwrap());
        let manager = DownloadManager::new(
            db.clone(),
            MangaClient::with_base(&server.uri(), Some(String::new())).unwrap(),
            Arc::new(RwLock::new(settings)),
            Arc::new(PdfManager::new()),
            Arc::new(|_| {}),
        )
        .unwrap();
        let item = DownloadRequest {
            comic: Comic {
                id: "test".into(),
                title: "旅程 100%".into(),
                ..Default::default()
            },
            chapter: Chapter {
                id: "ch1".into(),
                title: "第1话".into(),
                index: 1,
                ..Default::default()
            },
        };
        manager.enqueue(vec![item.clone(), item.clone()]).unwrap();
        wait(&manager).await;
        assert_eq!(manager.snapshot().tasks.len(), 1);
        assert_eq!(manager.snapshot().tasks[0].status, "done");
        let pages = library::files(&db, &root, "test", "ch1").unwrap();
        for (index, path) in pages.iter().enumerate() {
            assert_eq!(image::image_dimensions(path).unwrap().0, 101 + index as u32);
        }
        let books = library::list(&db, &root).unwrap();
        assert_eq!(books[0].total_pages, 2);
        assert_eq!(
            lopdf::Document::load(books[0].chapters[0].pdf_path.as_ref().unwrap())
                .unwrap()
                .get_pages()
                .len(),
            2
        );
        assert_eq!(pages[1].extension().unwrap(), "png");
        std::fs::remove_file(&pages[1]).unwrap();
        let mut interrupted = manager.snapshot().tasks[0].clone();
        interrupted.status = "running".into();
        interrupted.completed = 1;
        db.save_queue(&[interrupted]).unwrap();
        let settings = manager.settings.clone();
        let client = manager.client.clone();
        let pdf = manager.pdf.clone();
        drop(manager);
        let manager =
            DownloadManager::new(db.clone(), client, settings, pdf, Arc::new(|_| {})).unwrap();
        assert_eq!(manager.snapshot().tasks[0].status, "pending");
        manager.start();
        wait(&manager).await;
        let task = manager.snapshot().tasks.last().unwrap().clone();
        assert_eq!(task.skipped, 1);
        assert_eq!(task.completed, 1);
        manager.action("clearFinished", None).unwrap();
        assert!(manager.snapshot().tasks.is_empty());
        assert_eq!(library::list(&db, &root).unwrap()[0].total_pages, 2);
    }

    /// 取消后已下载的页必须落库（书库可见、可补齐），而不是变成孤儿文件。
    #[tokio::test]
    async fn canceled_download_persists_partial_chapter() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/v3/comic/test/chapter2/ch1"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({"code":200,"results":{
                    "chapter":{"contents":[{"url":"/1.jpg"},{"url":"/2.jpg"}],"words":[0,1]},
                    "comic":{"name":"test"}}})),
            )
            // 故意慢响应，让取消发生在第一页落盘之后
            .mount(&server)
            .await;
        for index in 1..=2 {
            let mut bytes = Vec::new();
            let image = image::RgbImage::from_pixel(10, 10, image::Rgb([1, 2, 3]));
            image::codecs::jpeg::JpegEncoder::new(&mut bytes)
                .encode_image(&image)
                .unwrap();
            Mock::given(method("GET"))
                .and(path(format!("/{index}.jpg")))
                .respond_with(ResponseTemplate::new(200).set_body_bytes(bytes).set_delay(Duration::from_millis(300)))
                .mount(&server)
                .await;
        }
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("books");
        std::fs::create_dir(&root).unwrap();
        let settings = Settings {
            download_directory: root.to_string_lossy().into_owned(),
            chapter_delay_min: 0,
            chapter_delay_max: 0,
            parallel_images: 1,
            ..Default::default()
        };
        let db = Arc::new(Database::open(&temp.path().join("db.sqlite")).unwrap());
        let manager = DownloadManager::new(
            db.clone(),
            MangaClient::with_base(&server.uri(), Some(String::new())).unwrap(),
            Arc::new(RwLock::new(settings)),
            Arc::new(PdfManager::new()),
            Arc::new(|_| {}),
        )
        .unwrap();
        manager
            .enqueue(vec![DownloadRequest {
                comic: Comic { id: "test".into(), title: "test".into(), ..Default::default() },
                chapter: Chapter { id: "ch1".into(), title: "第1话".into(), index: 1, ..Default::default() },
            }])
            .unwrap();
        // 等第一页落盘后取消
        for _ in 0..100 {
            if manager.snapshot().tasks.iter().any(|t| t.completed + t.skipped > 0) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        manager.action("cancelAll", None).unwrap();
        wait(&manager).await;
        // 书库能看到该章节，且未被标记完成
        let books = library::list(&db, &root).unwrap();
        assert_eq!(books.len(), 1, "取消后章节必须出现在书库");
        assert_eq!(books[0].chapters.len(), 1);
        assert!(!books[0].chapters[0].complete, "取消的章节不能是完成态");
        assert!(!books[0].chapters[0].failed_pages.is_empty(), "缺页应被记录以便补齐");
    }
}
