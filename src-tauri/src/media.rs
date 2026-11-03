use crate::{image_protocol,state::AppState,storage};
use std::{path::PathBuf,sync::{Arc,OnceLock}};
use tauri::Manager;
fn response(status:u16,mime:&str,body:Vec<u8>)->tauri::http::Response<Vec<u8>>{
    tauri::http::Response::builder().status(status).header("Content-Type",mime).header("Access-Control-Allow-Origin","*")
        .header("Cache-Control",if status==200{"private, max-age=3600"}else{"no-store"}).body(body).unwrap_or_else(|_|tauri::http::Response::new(Vec::new()))
}
fn mime(bytes:&[u8])->&'static str{match image::guess_format(bytes).ok(){Some(image::ImageFormat::Png)=>"image/png",Some(image::ImageFormat::WebP)=>"image/webp",Some(image::ImageFormat::Gif)=>"image/gif",Some(image::ImageFormat::Bmp)=>"image/bmp",_=>"image/jpeg"}}
fn limit()->&'static tokio::sync::Semaphore{static LIMIT:OnceLock<tokio::sync::Semaphore>=OnceLock::new();LIMIT.get_or_init(||tokio::sync::Semaphore::new(8))}
#[derive(serde::Deserialize)]#[serde(rename_all="camelCase")]struct LocalImage{comic_id:String,chapter_id:String,page:usize}
pub fn handle(app:tauri::AppHandle,request:tauri::http::Request<Vec<u8>>,responder:tauri::UriSchemeResponder){
    let route=image_protocol::parse_image_uri(&request.uri().to_string());
    let Ok((kind,target))=route else{responder.respond(response(400,"text/plain",b"bad image route".to_vec()));return;};
    tauri::async_runtime::spawn(async move{
        let state=app.state::<Arc<AppState>>().inner().clone();
        let bytes=if kind=="local"{
            async{
                let image:LocalImage=serde_json::from_str(&target).map_err(|_|"invalid local image")?;
                let paths=crate::library::files(&state.db,&state.root(),&image.comic_id,&image.chapter_id).map_err(|_|"image not found")?;
                let path=paths.get(image.page).ok_or("image not found")?;
                tokio::fs::read(path).await.map_err(|_|"image not found")
            }.await
        }else{
            async{
                state.client.validate_image_url(&target).map_err(|_|"invalid image address")?;
                use sha2::{Digest,Sha256};let hash=hex::encode(Sha256::digest(target.as_bytes()));
                let cache=state.cache_root.join("images").join(&hash[..2]).join(&hash);
                if let Ok(bytes)=tokio::fs::read(&cache).await{return Ok(bytes);}
                let _permit=limit().acquire().await.map_err(|_|"image queue closed")?;
                let bytes=state.client.image(&target).await.map_err(|_|"image request failed")?;
                if bytes.len()<=8*1024*1024{
                    let path=cache.clone();let save=bytes.clone();let _=tauri::async_runtime::spawn_blocking(move||storage::atomic_write(&path,&save)).await;
                    let root=state.cache_root.join("images");
                    let cap=state.settings.read().map(|s|s.image_cache_limit_mb*1024*1024).unwrap_or(256*1024*1024);
                    tauri::async_runtime::spawn_blocking(move||evict(root,cap));
                }Ok(bytes)
            }.await
        };
        match bytes{Ok(bytes)=>responder.respond(response(200,mime(&bytes),bytes)),Err(_)=>responder.respond(response(404,"text/plain",b"image unavailable".to_vec()))}
    });
}
fn evict(root:PathBuf,limit:u64){
    let mut files=Vec::new();let mut total=0;
    if let Ok(dirs)=std::fs::read_dir(root){
        for dir in dirs.flatten(){if let Ok(entries)=std::fs::read_dir(dir.path()){for file in entries.flatten(){if let Ok(meta)=file.metadata(){if meta.is_file(){total+=meta.len();files.push((meta.modified().ok(),meta.len(),file.path()));}}}}}
    }
    if total<=limit{return;}files.sort_by_key(|f|f.0);
    for(_,size,path)in files{if total<=limit*9/10{break;}if std::fs::remove_file(path).is_ok(){total=total.saturating_sub(size);}}
}
