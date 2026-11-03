mod api;
mod commands;
mod db;
mod download;
mod image_protocol;
mod library;
mod media;
mod models;
mod pdf;
mod state;
mod storage;
mod updates;

use commands::*;
use tauri::Manager;
use updates::*;
#[cfg(feature = "ui-smoke-test")]
#[tauri::command]
fn smoke_done(app: tauri::AppHandle, report: serde_json::Value) {
    if let Some(path) = std::env::var_os("COPYCOPY_SMOKE_REPORT") {
        let _ = std::fs::write(path, serde_json::to_vec(&report).unwrap());
    }
    app.exit(if report["ok"].as_bool() == Some(true) {
        0
    } else {
        1
    });
}
macro_rules! handlers { ($($extra:ident),*) => {
    tauri::generate_handler![app_snapshot,search_comics,get_comic,get_chapters,get_queue,enqueue_downloads,queue_action,
        get_library,delete_downloads,export_pdf,retry_incomplete,get_reader_pages,get_reading_progress,save_reading_progress,
        get_subscriptions,set_subscription,remove_subscription,check_subscriptions,update_settings,pick_download_directory,
        open_location,open_chapter,clear_image_cache,get_app_version,check_for_updates,download_update,install_update,open_update_release $(,$extra)*]
}; }
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                .build(),
        )
        .manage(UpdateManager::default())
        .register_asynchronous_uri_scheme_protocol("copyimg", |context, request, responder| {
            media::handle(context.app_handle().clone(), request, responder)
        })
        .setup(|app| {
            let state =
                state::AppState::initialize(app.handle().clone()).map_err(std::io::Error::other)?;
            app.manage(state.clone());
            state.start_background();
            Ok(())
        });
    #[cfg(feature="ui-smoke-test")]
    let builder=builder.on_page_load(|webview,payload|{
        if payload.event()!=tauri::webview::PageLoadEvent::Finished{return;}
        let _=webview.eval(r#"(async()=>{
            const invoke=window.__TAURI_INTERNALS__.invoke;
            try{
                for(let n=0;n<200&&!document.querySelector('[data-app-ready]');n++)await new Promise(r=>setTimeout(r,50));
                const before=await invoke('app_snapshot');
                const changed=await invoke('update_settings',{patch:{compactCards:true}});
                const library=await invoke('get_library');
                const queue=await invoke('get_queue');
                const ok=!!document.querySelector('[aria-label="主导航"]')&&before.version==='2.0.0'&&changed.compactCards===true&&Array.isArray(library)&&Array.isArray(queue.tasks);
                await invoke('smoke_done',{report:{ok,version:before.version,library:library.length,bridge:true}});
            }catch(error){await invoke('smoke_done',{report:{ok:false,error:String(error)}})}
        })()"#);
    });
    #[cfg(feature = "ui-smoke-test")]
    let builder = builder.invoke_handler(handlers!(smoke_done));
    #[cfg(not(feature = "ui-smoke-test"))]
    let builder = builder.invoke_handler(handlers!());
    builder
        .run(tauri::generate_context!())
        .expect("CopyCopy desktop runtime failed");
}
