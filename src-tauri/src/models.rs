use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    pub appearance: String,
    pub sidebar_collapsed: bool,
    pub compact_cards: bool,
    pub parallel_images: usize,
    pub chapter_delay_min: u64,
    pub chapter_delay_max: u64,
    pub export_pdf_after_download: bool,
    pub pdf_password: Option<String>,
    pub check_updates_on_launch: bool,
    pub check_subscriptions_on_launch: bool,
    pub subscription_interval_hours: u64,
    pub notify_on_done: bool,
    pub proxy_mode: String,
    pub proxy_url: String,
    pub download_directory: String,
    pub image_cache_limit_mb: u64,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            appearance: "system".into(),
            sidebar_collapsed: false,
            compact_cards: false,
            parallel_images: 5,
            chapter_delay_min: 3,
            chapter_delay_max: 6,
            export_pdf_after_download: false,
            pdf_password: None,
            check_updates_on_launch: true,
            check_subscriptions_on_launch: false,
            subscription_interval_hours: 0,
            notify_on_done: true,
            proxy_mode: "system".into(),
            proxy_url: String::new(),
            download_directory: String::new(),
            image_cache_limit_mb: 256,
        }
    }
}
impl Settings {
    pub fn validate(&mut self) -> Result<(), String> {
        if !["system", "light", "dark"].contains(&self.appearance.as_str()) {
            return Err("外观设置无效".into());
        }
        if !["system", "direct", "custom"].contains(&self.proxy_mode.as_str()) {
            return Err("代理模式无效".into());
        }
        if self.proxy_mode == "custom" && self.proxy_url.trim().is_empty() {
            return Err("请填写自定义代理地址".into());
        }
        if !(1..=16).contains(&self.parallel_images) {
            return Err("图片并发数应为 1–16".into());
        }
        if self.chapter_delay_min > self.chapter_delay_max || self.chapter_delay_max > 300 {
            return Err("章节等待时间应为 0–300 秒，最小值不能大于最大值".into());
        }
        if self.subscription_interval_hours > 168 {
            return Err("订阅检查间隔应为 0–168 小时".into());
        }
        if !(16..=8192).contains(&self.image_cache_limit_mb) {
            return Err("封面缓存容量应为 16–8192 MB".into());
        }
        if self.pdf_password.as_ref().is_some_and(|p| p.is_empty()) {
            self.pdf_password = None;
        }
        Ok(())
    }
    pub fn effective_proxy(&self) -> Option<String> {
        match self.proxy_mode.as_str() {
            "direct" => Some(String::new()),
            "custom" => Some(self.proxy_url.clone()),
            _ => None,
        }
    }
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Comic {
    pub id: String,
    pub title: String,
    pub alias: String,
    pub cover: String,
    pub authors: Vec<String>,
    pub description: String,
    pub updated_at: String,
    pub latest_chapter: String,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Chapter {
    pub id: String,
    pub title: String,
    pub index: u64,
    pub page_count: u64,
    pub updated_at: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Page<T> {
    pub items: Vec<T>,
    pub total: u64,
    pub page: u64,
    pub page_size: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadRequest {
    pub comic: Comic,
    pub chapter: Chapter,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct DownloadTask {
    pub id: String,
    pub comic: Comic,
    pub chapter: Chapter,
    pub directory: String,
    pub status: String,
    pub completed: u64,
    pub total: u64,
    pub skipped: u64,
    pub failed_pages: Vec<u64>,
    pub error: Option<String>,
    pub started_at: Option<i64>,
    pub finished_at: Option<i64>,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct QueueSnapshot {
    pub revision: u64,
    pub tasks: Vec<DownloadTask>,
}
/// 进度事件负载：序列化为两种形态之一，前端按字段判定：
/// - Full 直接是 {revision, tasks}，前端整块 apply；
/// - Delta 是 {revision, task}，前端按 id merge。
/// 用 untagged 保证 wire 格式与前端契约完全一致（不引入额外包装字段）。
#[derive(Debug, Clone, Serialize)]
#[serde(untagged)]
pub enum QueueEvent {
    Full(QueueSnapshot),
    Delta { revision: u64, task: DownloadTask },
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalChapter {
    pub id: String,
    pub comic_id: String,
    pub title: String,
    pub index: u64,
    pub directory: String,
    pub total: u64,
    pub page_count: usize,
    pub failed_pages: Vec<u64>,
    pub complete: bool,
    pub pdf_path: Option<String>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryBook {
    pub progress: Option<ReadingProgress>,
    pub comic: Comic,
    pub chapters: Vec<LocalChapter>,
    pub total_pages: usize,
    pub incomplete_count: usize,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ReadingProgress {
    pub comic_id: String,
    pub chapter_id: String,
    pub page: usize,
    pub updated_at: i64,
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn queue_event_wire_format_matches_frontend_contract() {
        let task = DownloadTask::default();
        let full = serde_json::to_value(&QueueEvent::Full(QueueSnapshot {
            revision: 3,
            tasks: vec![task.clone()],
        }))
        .unwrap();
        // Full 必须直接是 {revision, tasks}，前端 apply() 才能整块吃下
        assert_eq!(full["revision"], 3);
        assert!(full["tasks"].is_array());
        assert!(full.get("full").is_none());
        assert!(full.get("task").is_none());
        let delta = serde_json::to_value(&QueueEvent::Delta { revision: 4, task }).unwrap();
        // Delta 必须是 {revision, task}，前端 merge() 按 id 合并
        assert_eq!(delta["revision"], 4);
        assert!(delta["task"].is_object());
        assert!(delta.get("tasks").is_none());
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Subscription {
    pub comic: Comic,
    pub last_chapter: u64,
    pub chapter_limit: u64,
    pub checked_at: Option<i64>,
    pub error: Option<String>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfResult {
    pub path: String,
    pub pages: usize,
}
