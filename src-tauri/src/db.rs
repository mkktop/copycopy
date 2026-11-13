use crate::models::*;
use rusqlite::{Connection, OptionalExtension, params};
use std::{path::Path, sync::Mutex};

/// 把绝对路径从旧下载目录前缀换到新目录；不是旧目录内的路径原样返回。
fn rebase(path: &str, old_root: &str, new_root: &str) -> String {
    let old = Path::new(old_root);
    let p = Path::new(path);
    if let Ok(relative) = p.strip_prefix(old) {
        Path::new(new_root).join(relative).to_string_lossy().into_owned()
    } else {
        path.to_string()
    }
}

pub struct Database {
    connection: Mutex<Connection>,
}
impl Database {
    pub fn open(path: &Path) -> Result<Self, String> {
        let db = Connection::open(path).map_err(|e| e.to_string())?;
        db.execute_batch("PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS comics(id TEXT PRIMARY KEY,body TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS chapters(root TEXT NOT NULL,comic_id TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(root,comic_id,id));
            CREATE TABLE IF NOT EXISTS downloads(id TEXT PRIMARY KEY,position INTEGER NOT NULL,body TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS reading(root TEXT NOT NULL,comic_id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(root,comic_id));
            CREATE TABLE IF NOT EXISTS subscriptions(comic_id TEXT PRIMARY KEY,body TEXT NOT NULL);").map_err(|e|e.to_string())?;
        Ok(Self {
            connection: Mutex::new(db),
        })
    }
    fn bodies<T: serde::de::DeserializeOwned>(
        &self,
        sql: &str,
        args: &[&dyn rusqlite::ToSql],
    ) -> Result<Vec<T>, String> {
        let db = self.connection.lock().map_err(|_| "数据库繁忙")?;
        let mut query = db.prepare(sql).map_err(|e| e.to_string())?;
        let values = query
            .query_map(args, |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        values
            .into_iter()
            .map(|v| serde_json::from_str(&v).map_err(|e| e.to_string()))
            .collect()
    }
    pub fn settings(&self) -> Result<Settings, String> {
        let db = self.connection.lock().map_err(|_| "数据库繁忙")?;
        let value: Option<String> = db
            .query_row(
                "SELECT value FROM settings WHERE key='preferences'",
                [],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        value
            .map(|v| serde_json::from_str(&v).map_err(|e| e.to_string()))
            .unwrap_or_else(|| Ok(Settings::default()))
    }
    pub fn save_settings(&self, value: &Settings) -> Result<(), String> {
        self.connection.lock().map_err(|_|"数据库繁忙")?.execute(
            "INSERT INTO settings(key,value) VALUES('preferences',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            [serde_json::to_string(value).map_err(|e|e.to_string())?]).map_err(|e|e.to_string())?;
        Ok(())
    }
    pub fn save_comic(&self, comic: &Comic) -> Result<(), String> {
        self.connection.lock().map_err(|_|"数据库繁忙")?.execute(
            "INSERT INTO comics(id,body) VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
            params![comic.id,serde_json::to_string(comic).map_err(|e|e.to_string())?]).map_err(|e|e.to_string())?;
        Ok(())
    }
    pub fn comic(&self, id: &str) -> Result<Option<Comic>, String> {
        Ok(self
            .bodies("SELECT body FROM comics WHERE id=?1", &[&id])?
            .into_iter()
            .next())
    }
    pub fn local_chapters(
        &self,
        root: &str,
        comic_id: Option<&str>,
    ) -> Result<Vec<LocalChapter>, String> {
        match comic_id {
            Some(id) => self.bodies(
                "SELECT body FROM chapters WHERE root=?1 AND comic_id=?2",
                &[&root, &id],
            ),
            None => self.bodies("SELECT body FROM chapters WHERE root=?1", &[&root]),
        }
    }
    pub fn local_chapter(
        &self,
        root: &str,
        comic_id: &str,
        id: &str,
    ) -> Result<Option<LocalChapter>, String> {
        Ok(self
            .bodies(
                "SELECT body FROM chapters WHERE root=?1 AND comic_id=?2 AND id=?3",
                &[&root, &comic_id, &id],
            )?
            .into_iter()
            .next())
    }
    pub fn save_chapter(&self, root: &str, chapter: &LocalChapter) -> Result<(), String> {
        self.connection.lock().map_err(|_|"数据库繁忙")?.execute(
            "INSERT INTO chapters(root,comic_id,id,body) VALUES(?1,?2,?3,?4) ON CONFLICT(root,comic_id,id) DO UPDATE SET body=excluded.body",
            params![root,chapter.comic_id,chapter.id,serde_json::to_string(chapter).map_err(|e|e.to_string())?]).map_err(|e|e.to_string())?;
        Ok(())
    }
    pub fn remove_chapter(&self, root: &str, comic_id: &str, id: &str) -> Result<(), String> {
        self.connection
            .lock()
            .map_err(|_| "数据库繁忙")?
            .execute(
                "DELETE FROM chapters WHERE root=?1 AND comic_id=?2 AND id=?3",
                params![root, comic_id, id],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    pub fn queue(&self) -> Result<Vec<DownloadTask>, String> {
        self.bodies("SELECT body FROM downloads ORDER BY position", &[])
    }
    pub fn save_queue(&self, tasks: &[DownloadTask]) -> Result<(), String> {
        let mut db = self.connection.lock().map_err(|_| "数据库繁忙")?;
        let transaction = db.transaction().map_err(|e| e.to_string())?;
        transaction
            .execute("DELETE FROM downloads", [])
            .map_err(|e| e.to_string())?;
        for (i, task) in tasks.iter().enumerate() {
            transaction
                .execute(
                    "INSERT INTO downloads(id,position,body) VALUES(?1,?2,?3)",
                    params![
                        task.id,
                        i as i64,
                        serde_json::to_string(task).map_err(|e| e.to_string())?
                    ],
                )
                .map_err(|e| e.to_string())?;
        }
        transaction.commit().map_err(|e| e.to_string())
    }
    pub fn save_task(&self, task: &DownloadTask, position: usize) -> Result<(), String> {
        self.connection.lock().map_err(|_|"数据库繁忙")?.execute(
            "INSERT INTO downloads(id,position,body) VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET position=excluded.position,body=excluded.body",
            params![task.id,position as i64,serde_json::to_string(task).map_err(|e|e.to_string())?]).map_err(|e|e.to_string())?;
        Ok(())
    }
    pub fn progress(&self, root: &str, comic_id: &str) -> Result<Option<ReadingProgress>, String> {
        Ok(self
            .bodies(
                "SELECT body FROM reading WHERE root=?1 AND comic_id=?2",
                &[&root, &comic_id],
            )?
            .into_iter()
            .next())
    }
    pub fn save_progress(&self, root: &str, value: &ReadingProgress) -> Result<(), String> {
        self.connection.lock().map_err(|_|"数据库繁忙")?.execute(
            "INSERT INTO reading(root,comic_id,body) VALUES(?1,?2,?3) ON CONFLICT(root,comic_id) DO UPDATE SET body=excluded.body",
            params![root,value.comic_id,serde_json::to_string(value).map_err(|e|e.to_string())?]).map_err(|e|e.to_string())?;
        Ok(())
    }
    pub fn subscriptions(&self) -> Result<Vec<Subscription>, String> {
        self.bodies("SELECT body FROM subscriptions ORDER BY comic_id", &[])
    }
    pub fn save_subscription(&self, value: &Subscription) -> Result<(), String> {
        self.save_comic(&value.comic)?;
        self.connection.lock().map_err(|_|"数据库繁忙")?.execute(
            "INSERT INTO subscriptions(comic_id,body) VALUES(?1,?2) ON CONFLICT(comic_id) DO UPDATE SET body=excluded.body",
            params![value.comic.id,serde_json::to_string(value).map_err(|e|e.to_string())?]).map_err(|e|e.to_string())?;
        Ok(())
    }
    pub fn remove_subscription(&self, id: &str) -> Result<(), String> {
        self.connection
            .lock()
            .map_err(|_| "数据库繁忙")?
            .execute("DELETE FROM subscriptions WHERE comic_id=?1", [id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    /// 下载目录变更后，把旧 root 下的章节/阅读进度重新挂到新 root。
    /// chapter.directory / pdf_path 存的是绝对路径，前缀也要一并替换；
    /// 冲突（新 root 已有同 comic+chapter）保留新记录，删除旧记录。
    pub fn rebind_root(&self, old_root: &str, new_root: &str) -> Result<(), String> {
        let mut db = self.connection.lock().map_err(|_| "数据库繁忙")?;
        let transaction = db.transaction().map_err(|e| e.to_string())?;
        // 逐条重写 body 里的绝对路径前缀（只替换开头，避免误伤同名子串）
        let rows: Vec<(String, String, String, String)> = transaction
            .prepare("SELECT root,comic_id,id,body FROM chapters WHERE root=?1")
            .and_then(|mut stmt| {
                stmt.query_map(params![old_root], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
                })?
                .collect::<Result<Vec<_>, _>>()
            })
            .map_err(|e| e.to_string())?;
        for (_, comic_id, id, body) in rows {
            let mut chapter: LocalChapter =
                serde_json::from_str(&body).map_err(|e| e.to_string())?;
            chapter.directory = rebase(&chapter.directory, old_root, new_root);
            chapter.pdf_path = chapter.pdf_path.map(|p| rebase(&p, old_root, new_root));
            let new_body = serde_json::to_string(&chapter).map_err(|e| e.to_string())?;
            // 先删旧主键，再以新 root 插入；冲突时保留新 root 已有的记录
            transaction
                .execute(
                    "DELETE FROM chapters WHERE root=?1 AND comic_id=?2 AND id=?3",
                    params![old_root, comic_id, id],
                )
                .map_err(|e| e.to_string())?;
            transaction
                .execute(
                    "INSERT OR IGNORE INTO chapters(root,comic_id,id,body) VALUES(?1,?2,?3,?4)",
                    params![new_root, comic_id, id, new_body],
                )
                .map_err(|e| e.to_string())?;
        }
        transaction
            .execute("DELETE FROM chapters WHERE root=?1", params![old_root])
            .map_err(|e| e.to_string())?;
        transaction
            .execute(
                "UPDATE OR IGNORE reading SET root=?1 WHERE root=?2",
                params![new_root, old_root],
            )
            .map_err(|e| e.to_string())?;
        transaction
            .execute("DELETE FROM reading WHERE root=?1", params![old_root])
            .map_err(|e| e.to_string())?;
        transaction.commit().map_err(|e| e.to_string())
    }
    /// 某 root 下是否有本地数据（切换目录前提示用）
    pub fn count_local(&self, root: &str) -> Result<usize, String> {
        let db = self.connection.lock().map_err(|_| "数据库繁忙")?;
        let n: i64 = db
            .query_row(
                "SELECT COUNT(*) FROM chapters WHERE root=?1",
                params![root],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        Ok(n as usize)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn settings_progress_and_tasks_survive_reopening() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("copycopy.sqlite");
        {
            let db = Database::open(&path).unwrap();
            let mut settings = Settings::default();
            settings.appearance = "dark".into();
            db.save_settings(&settings).unwrap();
            db.save_progress(
                "root",
                &ReadingProgress {
                    comic_id: "journey".into(),
                    chapter_id: "ch2".into(),
                    page: 7,
                    updated_at: 1,
                },
            )
            .unwrap();
            db.save_queue(&[DownloadTask {
                id: "task1".into(),
                status: "pending".into(),
                ..Default::default()
            }])
            .unwrap();
        }
        let db = Database::open(&path).unwrap();
        assert_eq!(db.settings().unwrap().appearance, "dark");
        assert_eq!(db.progress("root", "journey").unwrap().unwrap().page, 7);
        assert!(db.progress("other", "journey").unwrap().is_none());
        assert_eq!(db.queue().unwrap()[0].id, "task1");
    }

    #[test]
    fn rebind_root_moves_chapters_and_progress_to_new_directory() {
        let temp = tempfile::tempdir().unwrap();
        let db = Database::open(&temp.path().join("copycopy.sqlite")).unwrap();
        db.save_chapter(
            "old",
            &LocalChapter {
                id: "ch1".into(),
                comic_id: "comic".into(),
                title: "第1话".into(),
                index: 1,
                directory: "old/comic/ch1".into(),
                total: 1,
                page_count: 1,
                failed_pages: vec![],
                complete: true,
                pdf_path: Some("old/comic/ch1.pdf".into()),
            },
        )
        .unwrap();
        db.save_progress(
            "old",
            &ReadingProgress {
                comic_id: "comic".into(),
                chapter_id: "ch1".into(),
                page: 3,
                updated_at: 1,
            },
        )
        .unwrap();
        assert_eq!(db.count_local("old").unwrap(), 1);
        db.rebind_root("old", "new").unwrap();
        assert_eq!(db.count_local("old").unwrap(), 0);
        let rebound = db.local_chapter("new", "comic", "ch1").unwrap().unwrap();
        let expected_dir = Path::new("new").join("comic").join("ch1");
        let expected_pdf = Path::new("new").join("comic").join("ch1.pdf");
        assert_eq!(Path::new(&rebound.directory), expected_dir.as_path());
        assert_eq!(
            rebound.pdf_path.as_deref().map(Path::new),
            Some(expected_pdf.as_path())
        );
        assert_eq!(db.progress("new", "comic").unwrap().unwrap().page, 3);
        assert!(db.progress("old", "comic").unwrap().is_none());
    }
}
