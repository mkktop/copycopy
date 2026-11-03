use crate::models::*;
use rusqlite::{params,Connection,OptionalExtension};
use std::{path::Path,sync::Mutex};

pub struct Database { connection:Mutex<Connection> }
impl Database {
    pub fn open(path:&Path)->Result<Self,String> {
        let db=Connection::open(path).map_err(|e|e.to_string())?;
        db.execute_batch("PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS comics(id TEXT PRIMARY KEY,body TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS chapters(root TEXT NOT NULL,comic_id TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(root,comic_id,id));
            CREATE TABLE IF NOT EXISTS downloads(id TEXT PRIMARY KEY,position INTEGER NOT NULL,body TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS reading(root TEXT NOT NULL,comic_id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(root,comic_id));
            CREATE TABLE IF NOT EXISTS subscriptions(comic_id TEXT PRIMARY KEY,body TEXT NOT NULL);").map_err(|e|e.to_string())?;
        Ok(Self{connection:Mutex::new(db)})
    }
    fn bodies<T:serde::de::DeserializeOwned>(&self,sql:&str,args:&[&dyn rusqlite::ToSql])->Result<Vec<T>,String> {
        let db=self.connection.lock().map_err(|_|"数据库繁忙")?;
        let mut query=db.prepare(sql).map_err(|e|e.to_string())?;
        let values=query.query_map(args,|r|r.get::<_,String>(0)).map_err(|e|e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?;
        values.into_iter().map(|v|serde_json::from_str(&v).map_err(|e|e.to_string())).collect()
    }
    pub fn settings(&self)->Result<Settings,String> {
        let db=self.connection.lock().map_err(|_|"数据库繁忙")?;
        let value:Option<String>=db.query_row("SELECT value FROM settings WHERE key='preferences'",[],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
        value.map(|v|serde_json::from_str(&v).map_err(|e|e.to_string())).unwrap_or_else(||Ok(Settings::default()))
    }
    pub fn save_settings(&self,value:&Settings)->Result<(),String> {
        self.connection.lock().map_err(|_|"数据库繁忙")?.execute(
            "INSERT INTO settings(key,value) VALUES('preferences',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            [serde_json::to_string(value).map_err(|e|e.to_string())?]).map_err(|e|e.to_string())?;
        Ok(())
    }
    pub fn save_comic(&self,comic:&Comic)->Result<(),String> {
        self.connection.lock().map_err(|_|"数据库繁忙")?.execute(
            "INSERT INTO comics(id,body) VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
            params![comic.id,serde_json::to_string(comic).map_err(|e|e.to_string())?]).map_err(|e|e.to_string())?;
        Ok(())
    }
    pub fn comic(&self,id:&str)->Result<Option<Comic>,String> {
        Ok(self.bodies("SELECT body FROM comics WHERE id=?1",&[&id])?.into_iter().next())
    }
    pub fn local_chapters(&self,root:&str,comic_id:Option<&str>)->Result<Vec<LocalChapter>,String> {
        match comic_id {
            Some(id)=>self.bodies("SELECT body FROM chapters WHERE root=?1 AND comic_id=?2",&[&root,&id]),
            None=>self.bodies("SELECT body FROM chapters WHERE root=?1",&[&root]),
        }
    }
    pub fn local_chapter(&self,root:&str,comic_id:&str,id:&str)->Result<Option<LocalChapter>,String> {
        Ok(self.bodies("SELECT body FROM chapters WHERE root=?1 AND comic_id=?2 AND id=?3",&[&root,&comic_id,&id])?.into_iter().next())
    }
    pub fn save_chapter(&self,root:&str,chapter:&LocalChapter)->Result<(),String> {
        self.connection.lock().map_err(|_|"数据库繁忙")?.execute(
            "INSERT INTO chapters(root,comic_id,id,body) VALUES(?1,?2,?3,?4) ON CONFLICT(root,comic_id,id) DO UPDATE SET body=excluded.body",
            params![root,chapter.comic_id,chapter.id,serde_json::to_string(chapter).map_err(|e|e.to_string())?]).map_err(|e|e.to_string())?;
        Ok(())
    }
    pub fn remove_chapter(&self,root:&str,comic_id:&str,id:&str)->Result<(),String> {
        self.connection.lock().map_err(|_|"数据库繁忙")?.execute("DELETE FROM chapters WHERE root=?1 AND comic_id=?2 AND id=?3",params![root,comic_id,id]).map_err(|e|e.to_string())?;
        Ok(())
    }
    pub fn queue(&self)->Result<Vec<DownloadTask>,String> { self.bodies("SELECT body FROM downloads ORDER BY position",&[]) }
    pub fn save_queue(&self,tasks:&[DownloadTask])->Result<(),String> {
        let mut db=self.connection.lock().map_err(|_|"数据库繁忙")?;
        let transaction=db.transaction().map_err(|e|e.to_string())?;
        transaction.execute("DELETE FROM downloads",[]).map_err(|e|e.to_string())?;
        for (i,task) in tasks.iter().enumerate() {
            transaction.execute("INSERT INTO downloads(id,position,body) VALUES(?1,?2,?3)",
                params![task.id,i as i64,serde_json::to_string(task).map_err(|e|e.to_string())?]).map_err(|e|e.to_string())?;
        }
        transaction.commit().map_err(|e|e.to_string())
    }
    pub fn save_task(&self,task:&DownloadTask,position:usize)->Result<(),String>{
        self.connection.lock().map_err(|_|"数据库繁忙")?.execute(
            "INSERT INTO downloads(id,position,body) VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET position=excluded.position,body=excluded.body",
            params![task.id,position as i64,serde_json::to_string(task).map_err(|e|e.to_string())?]).map_err(|e|e.to_string())?;Ok(())
    }
    pub fn progress(&self,root:&str,comic_id:&str)->Result<Option<ReadingProgress>,String> {
        Ok(self.bodies("SELECT body FROM reading WHERE root=?1 AND comic_id=?2",&[&root,&comic_id])?.into_iter().next())
    }
    pub fn save_progress(&self,root:&str,value:&ReadingProgress)->Result<(),String> {
        self.connection.lock().map_err(|_|"数据库繁忙")?.execute(
            "INSERT INTO reading(root,comic_id,body) VALUES(?1,?2,?3) ON CONFLICT(root,comic_id) DO UPDATE SET body=excluded.body",
            params![root,value.comic_id,serde_json::to_string(value).map_err(|e|e.to_string())?]).map_err(|e|e.to_string())?;
        Ok(())
    }
    pub fn subscriptions(&self)->Result<Vec<Subscription>,String> { self.bodies("SELECT body FROM subscriptions ORDER BY comic_id",&[]) }
    pub fn save_subscription(&self,value:&Subscription)->Result<(),String> {
        self.save_comic(&value.comic)?;
        self.connection.lock().map_err(|_|"数据库繁忙")?.execute(
            "INSERT INTO subscriptions(comic_id,body) VALUES(?1,?2) ON CONFLICT(comic_id) DO UPDATE SET body=excluded.body",
            params![value.comic.id,serde_json::to_string(value).map_err(|e|e.to_string())?]).map_err(|e|e.to_string())?;
        Ok(())
    }
    pub fn remove_subscription(&self,id:&str)->Result<(),String> {
        self.connection.lock().map_err(|_|"数据库繁忙")?.execute("DELETE FROM subscriptions WHERE comic_id=?1",[id]).map_err(|e|e.to_string())?;Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn settings_progress_and_tasks_survive_reopening() {
        let temp=tempfile::tempdir().unwrap();let path=temp.path().join("copycopy.sqlite");
        {
            let db=Database::open(&path).unwrap();let mut settings=Settings::default();settings.appearance="dark".into();db.save_settings(&settings).unwrap();
            db.save_progress("root",&ReadingProgress{comic_id:"journey".into(),chapter_id:"ch2".into(),page:7,updated_at:1}).unwrap();
            db.save_queue(&[DownloadTask{id:"task1".into(),status:"pending".into(),..Default::default()}]).unwrap();
        }
        let db=Database::open(&path).unwrap();
        assert_eq!(db.settings().unwrap().appearance,"dark");
        assert_eq!(db.progress("root","journey").unwrap().unwrap().page,7);
        assert!(db.progress("other","journey").unwrap().is_none());
        assert_eq!(db.queue().unwrap()[0].id,"task1");
    }
}
