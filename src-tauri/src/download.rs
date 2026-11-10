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
    time::Duration,
};
use tokio_util::sync::CancellationToken;
type Sink = Arc<dyn Fn(QueueSnapshot) + Send + Sync>;
pub struct DownloadManager {
    queue: Mutex<QueueSnapshot>,
    active: AtomicBool,
    tokens: Mutex<HashMap<String, CancellationToken>>,
    pub db: Arc<Database>,
    client: MangaClient,
    settings: Arc<RwLock<Settings>>,
    pdf: Arc<PdfManager>,
    sink: Sink,
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
        Ok(Arc::new(Self {
            queue: Mutex::new(QueueSnapshot { revision: 0, tasks }),
            active: AtomicBool::new(false),
            tokens: Mutex::new(HashMap::new()),
            db,
            client,
            settings,
            pdf,
            sink,
        }))
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
    fn publish(&self, snapshot: QueueSnapshot) {
        (self.sink)(snapshot);
    }
    fn update(&self, id: &str, change: impl FnOnce(&mut DownloadTask)) -> Result<(), String> {
        let snapshot = {
            let mut queue = self.queue.lock().map_err(|_| "下载队列繁忙")?;
            if let Some((index, task)) =
                queue.tasks.iter_mut().enumerate().find(|(_, t)| t.id == id)
            {
                change(task);
                self.db.save_task(task, index)?;
            }
            queue.revision += 1;
            queue.clone()
        };
        self.publish(snapshot);
        Ok(())
    }
    pub fn enqueue(self: &Arc<Self>, items: Vec<DownloadRequest>) -> Result<QueueSnapshot, String> {
        if items.len() > 500 {
            return Err("每次最多加入 500 个章节".into());
        }
        {
            let mut queue = self.queue.lock().map_err(|_| "下载队列繁忙")?;
            if queue
                .tasks
                .iter()
                .filter(|t| t.status == "pending" || t.status == "running")
                .count()
                + items.len()
                > 1000
            {
                return Err("队列已满，请完成部分任务后再添加".into());
            }
            let root = PathBuf::from(
                &self
                    .settings
                    .read()
                    .map_err(|_| "设置繁忙")?
                    .download_directory,
            );
            for item in items {
                if item.comic.id.is_empty() || item.chapter.id.is_empty() {
                    return Err("漫画或章节标识无效".into());
                }
                if queue.tasks.iter().any(|t| {
                    t.comic.id == item.comic.id
                        && t.chapter.id == item.chapter.id
                        && (t.status == "pending" || t.status == "running")
                }) {
                    continue;
                }
                let dir = library::chapter_directory(&root, &item.comic, &item.chapter)?;
                self.db.save_comic(&item.comic)?;
                queue.tasks.push(DownloadTask {
                    id: uuid::Uuid::new_v4().to_string(),
                    comic: item.comic,
                    chapter: item.chapter,
                    directory: dir.to_string_lossy().into_owned(),
                    status: "pending".into(),
                    ..Default::default()
                });
            }
            let mut finished = queue
                .tasks
                .iter()
                .filter(|t| !["pending", "running"].contains(&t.status.as_str()))
                .count();
            queue.tasks.retain(|t| {
                if finished > 500 && !["pending", "running"].contains(&t.status.as_str()) {
                    finished -= 1;
                    false
                } else {
                    true
                }
            });
            queue.revision += 1;
            self.db.save_queue(&queue.tasks)?;
        }
        self.publish(self.snapshot());
        self.start();
        Ok(self.snapshot())
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
        self.publish(snapshot.clone());
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
                    let mut queue = this.queue.lock().unwrap_or_else(|e| e.into_inner());
                    let next = queue.tasks.iter().find(|t| t.status == "pending").cloned();
                    if next.is_none() {
                        this.active.store(false, Ordering::SeqCst);
                    }
                    next
                };
                let Some(task) = next else {
                    break;
                };
                let token = CancellationToken::new();
                this.tokens
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .insert(task.id.clone(), token.clone());
                if let Err(error) = this.process(task.clone(), token.clone()).await {
                    let _ = this.update(&task.id, |t| {
                        if t.status != "canceled" {
                            t.status = "failed".into();
                            t.error = Some(error);
                            t.finished_at = Some(chrono::Utc::now().timestamp_millis());
                        }
                    });
                }
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
        })?;
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
        self.update(&task.id, |t| t.total = total)?;
        let this = self.clone();
        let task_id = task.id.clone();
        let token_for_pages = token.clone();
        stream::iter(pages.urls.into_iter().enumerate())
            .for_each_concurrent(settings.parallel_images, move |(index, url)| {
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
                    let _ = this.update(&id, |task| match result {
                        Ok(true) => task.skipped += 1,
                        Ok(false) => task.completed += 1,
                        Err(_) => task.failed_pages.push(index as u64 + 1),
                    });
                }
            })
            .await;
        if token.is_cancelled() {
            return Ok(());
        }
        let current = self
            .snapshot()
            .tasks
            .into_iter()
            .find(|t| t.id == task.id)
            .ok_or("下载任务已移除")?;
        let mut chapter = LocalChapter {
            id: task.chapter.id.clone(),
            comic_id: task.comic.id.clone(),
            title: task.chapter.title.clone(),
            index: task.chapter.index,
            directory: task.directory.clone(),
            total,
            page_count: (current.completed + current.skipped) as usize,
            complete: current.failed_pages.is_empty(),
            failed_pages: current.failed_pages.clone(),
            pdf_path: None,
        };
        if chapter.complete && settings.export_pdf_after_download {
            self.update(&task.id, |t| t.error = Some("正在生成 PDF…".into()))?;
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
                    self.update(&task.id, |t| t.error = None)?;
                }
                Err(error) => {
                    self.update(&task.id, |t| {
                        t.error = Some(format!("图片已下载，PDF 导出失败：{error}"))
                    })?;
                }
            }
        }
        self.db.save_chapter(&root.to_string_lossy(), &chapter)?;
        if chapter.complete {
            let done: BTreeSet<u64> = self
                .db
                .local_chapters(&root.to_string_lossy(), Some(&task.comic.id))?
                .into_iter()
                .filter(|c| c.complete)
                .map(|c| c.index)
                .collect();
            if let Some(mut sub) = self
                .db
                .subscriptions()?
                .into_iter()
                .find(|s| s.comic.id == task.comic.id)
            {
                while done.contains(&(sub.last_chapter + 1)) {
                    sub.last_chapter += 1;
                }
                self.db.save_subscription(&sub)?;
            }
        }
        self.update(&task.id, |t| {
            t.status = if chapter.complete { "done" } else { "failed" }.into();
            if !chapter.complete {
                t.error = Some(format!(
                    "有 {} 页下载失败，可重试补齐",
                    t.failed_pages.len()
                ));
            }
            t.finished_at = Some(chrono::Utc::now().timestamp_millis());
        })?;
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
}
