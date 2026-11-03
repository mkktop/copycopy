use crate::state::AppState;
use std::sync::Arc;
use reqwest::{Client, StatusCode};
use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{path::PathBuf, time::Duration};
use tauri::{Manager, State, ipc::Channel};
use tauri_plugin_opener::OpenerExt;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::Mutex,
};

const RELEASES_URL: &str = "https://github.com/mkktop/copycopy/releases";
const LATEST_RELEASE_API: &str = "https://api.github.com/repos/mkktop/copycopy/releases/latest";
const MAX_INSTALLER_SIZE: u64 = 512 * 1024 * 1024;

#[derive(Debug, Deserialize)]
struct Release {
    tag_name: String,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    published_at: Option<String>,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
    #[serde(default)]
    assets: Vec<Asset>,
}

#[derive(Debug, Clone, Deserialize)]
struct Asset {
    name: String,
    browser_download_url: String,
    size: u64,
    #[serde(default)]
    digest: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
enum UpdateStatus {
    Available,
    Current,
    Unpublished,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum InstallerKind {
    Windows,
    Macos,
}

impl InstallerKind {
    fn extension(self) -> &'static str {
        match self {
            Self::Windows => "exe",
            Self::Macos => "dmg",
        }
    }
}

#[derive(Debug, Serialize)]
pub struct UpdateCheck {
    status: UpdateStatus,
    current_version: String,
    version: Option<String>,
    notes: Option<String>,
    published_at: Option<String>,
    can_install: bool,
    download_size: Option<u64>,
    installer_kind: Option<InstallerKind>,
}

struct PendingUpdate {
    asset: Asset,
    kind: InstallerKind,
    downloaded: Option<PathBuf>,
}

/// Keep trusted release metadata and installer paths in Rust, never in IPC arguments.
#[derive(Default)]
pub struct UpdateManager {
    pending: Mutex<Option<PendingUpdate>>,
}

#[derive(Clone, Serialize)]
pub struct UpdateProgress {
    downloaded: u64,
    total: u64,
}

fn release_version(tag: &str) -> Result<Version, String> {
    let tag = tag.trim();
    Version::parse(tag.strip_prefix(['v', 'V']).unwrap_or(tag))
        .map_err(|_| format!("发布版本号无效：{tag}"))
}

fn expected_digest(asset: &Asset) -> Option<&str> {
    let value = asset.digest.as_deref()?.strip_prefix("sha256:")?;
    (value.len() == 64 && value.bytes().all(|c| c.is_ascii_hexdigit())).then_some(value)
}

fn trusted_download(url: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(url) else {
        return false;
    };
    url.scheme() == "https"
        && url.host_str() == Some("github.com")
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
        && url
            .path()
            .starts_with("/mkktop/copycopy/releases/download/")
}

fn installer_for(release: &Release, os: &str, arch: &str) -> Option<(Asset, InstallerKind)> {
    let (suffixes, kind): (&[&str], InstallerKind) = match (os, arch) {
        ("windows", "x86_64") => (&["_x64-setup.exe"], InstallerKind::Windows),
        ("windows", "aarch64") => (&["_arm64-setup.exe"], InstallerKind::Windows),
        ("macos", "aarch64") => (&["_aarch64.dmg", "_universal.dmg"], InstallerKind::Macos),
        ("macos", "x86_64") => (&["_x64.dmg", "_universal.dmg"], InstallerKind::Macos),
        _ => return None,
    };
    suffixes.iter().find_map(|suffix| {
        release
            .assets
            .iter()
            .find(|asset| {
                asset.name.ends_with(suffix)
                    && asset.size > 0
                    && asset.size <= MAX_INSTALLER_SIZE
                    && expected_digest(asset).is_some()
                    && trusted_download(&asset.browser_download_url)
            })
            .cloned()
            .map(|asset| (asset, kind))
    })
}

fn evaluate_release(
    current: &str,
    release: Option<Release>,
    os: &str,
    arch: &str,
) -> Result<(UpdateCheck, Option<PendingUpdate>), String> {
    let mut check = UpdateCheck {
        status: UpdateStatus::Unpublished,
        current_version: current.to_string(),
        version: None,
        notes: None,
        published_at: None,
        can_install: false,
        download_size: None,
        installer_kind: None,
    };
    let Some(release) = release else {
        return Ok((check, None));
    };
    let latest = release_version(&release.tag_name)?;
    let current = release_version(current)?;
    if release.draft || release.prerelease || !latest.pre.is_empty() {
        return Ok((check, None));
    }
    check.status = UpdateStatus::Current;
    // Build metadata must not turn the same semantic version into an upgrade.
    if !latest.cmp_precedence(&current).is_gt() {
        return Ok((check, None));
    }
    let asset = installer_for(&release, os, arch);
    check.status = UpdateStatus::Available;
    check.version = Some(latest.to_string());
    check.notes = release.body;
    check.published_at = release.published_at;
    check.can_install = asset.is_some();
    check.download_size = asset.as_ref().map(|(asset, _)| asset.size);
    check.installer_kind = asset.as_ref().map(|(_, kind)| *kind);
    Ok((
        check,
        asset.map(|(asset, kind)| PendingUpdate {
            asset,
            kind,
            downloaded: None,
        }),
    ))
}

fn http_client(proxy: Option<&str>, timeout: Duration) -> Result<Client, String> {
    let mut builder = Client::builder()
        .user_agent(concat!("CopyCopy/", env!("CARGO_PKG_VERSION")))
        .https_only(true)
        .connect_timeout(Duration::from_secs(15))
        .timeout(timeout);
    if let Some(proxy) = proxy {
        if proxy.trim().is_empty() { builder = builder.no_proxy(); }
        else { builder = builder.proxy(reqwest::Proxy::all(proxy).map_err(|_| "代理地址无效")?); }
    }
    builder
        .build()
        .map_err(|_| "无法初始化更新连接".to_string())
}

#[tauri::command]
pub fn get_app_version(app: tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}

#[tauri::command]
pub async fn check_for_updates(
    app: tauri::AppHandle,
    state: State<'_, Arc<AppState>>,
    updates: State<'_, UpdateManager>,
) -> Result<UpdateCheck, String> {
    let mut pending = updates
        .pending
        .try_lock()
        .map_err(|_| "更新任务正在进行，请稍后重试")?;
    if let Some(previous) = pending.take().and_then(|p| p.downloaded) {
        let _ = tokio::fs::remove_file(previous).await;
    }
    let proxy = state.client.proxy();
    let client = http_client(proxy.as_deref(), Duration::from_secs(30))?;
    let response = client
        .get(LATEST_RELEASE_API)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .await
        .map_err(|_| "无法连接 GitHub，请检查网络或代理设置后重试")?;
    let release = match response.status() {
        StatusCode::NOT_FOUND => None,
        StatusCode::FORBIDDEN | StatusCode::TOO_MANY_REQUESTS => {
            return Err("GitHub 请求受限，请稍后重试或检查代理设置".to_string());
        }
        status if status.is_success() => Some(
            response
                .json::<Release>()
                .await
                .map_err(|_| "无法读取版本信息，请稍后重试")?,
        ),
        status => return Err(format!("更新服务返回 HTTP {}，请稍后重试", status.as_u16())),
    };
    let (check, next) = evaluate_release(
        &app.package_info().version.to_string(),
        release,
        std::env::consts::OS,
        std::env::consts::ARCH,
    )?;
    *pending = next;
    Ok(check)
}

async fn download_installer(
    client: &Client,
    asset: &Asset,
    path: &std::path::Path,
    on_progress: &Channel<UpdateProgress>,
) -> Result<(), String> {
    let mut response = client
        .get(&asset.browser_download_url)
        .send()
        .await
        .map_err(|_| "下载连接失败，请检查网络或代理设置后重试")?;
    if !response.status().is_success() {
        return Err(format!(
            "安装包下载失败（HTTP {}）",
            response.status().as_u16()
        ));
    }
    let mut file = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .await
        .map_err(|_| "无法创建更新文件，请检查磁盘空间和目录权限")?;
    let mut hash = Sha256::new();
    let mut downloaded = 0u64;
    let mut last_progress = std::time::Instant::now();
    let _ = on_progress.send(UpdateProgress {
        downloaded,
        total: asset.size,
    });
    while let Some(chunk) = response.chunk().await.map_err(|_| "下载中断，请重试")? {
        downloaded += chunk.len() as u64;
        if downloaded > asset.size {
            return Err("安装包大小与发布信息不符，请重新检查更新".to_string());
        }
        hash.update(&chunk);
        file.write_all(&chunk)
            .await
            .map_err(|_| "写入安装包失败，请检查磁盘空间")?;
        if last_progress.elapsed() >= Duration::from_millis(100) {
            let _ = on_progress.send(UpdateProgress {
                downloaded,
                total: asset.size,
            });
            last_progress = std::time::Instant::now();
        }
    }
    file.flush()
        .await
        .map_err(|_| "保存安装包失败，请检查磁盘空间")?;
    verify_installer(asset, downloaded, &hex::encode(hash.finalize()))?;
    let _ = on_progress.send(UpdateProgress {
        downloaded,
        total: asset.size,
    });
    Ok(())
}

fn verify_installer(asset: &Asset, size: u64, digest: &str) -> Result<(), String> {
    if size != asset.size
        || !expected_digest(asset).is_some_and(|expected| expected.eq_ignore_ascii_case(digest))
    {
        return Err("安装包校验失败，请重新检查更新并下载".to_string());
    }
    Ok(())
}

#[tauri::command]
pub async fn download_update(
    app: tauri::AppHandle,
    state: State<'_, Arc<AppState>>,
    updates: State<'_, UpdateManager>,
    on_progress: Channel<UpdateProgress>,
) -> Result<(), String> {
    let mut guard = updates
        .pending
        .try_lock()
        .map_err(|_| "更新任务正在进行，请稍后重试")?;
    let pending = guard
        .as_mut()
        .ok_or("请先检查更新，确认有适配当前系统的安装包")?;
    if pending.downloaded.is_some() {
        return Ok(());
    }
    let proxy = state.client.proxy();
    let client = http_client(proxy.as_deref(), Duration::from_secs(600))?;
    let directory = app
        .path()
        .app_cache_dir()
        .map_err(|_| "无法获取更新缓存目录")?
        .join("updates");
    tokio::fs::create_dir_all(&directory)
        .await
        .map_err(|_| "无法创建更新缓存目录")?;
    // Random local names avoid trusting release asset names as file paths.
    let path = directory.join(format!(
        "{}.{}",
        uuid::Uuid::new_v4(),
        pending.kind.extension()
    ));
    if let Err(error) = download_installer(&client, &pending.asset, &path, &on_progress).await {
        let _ = tokio::fs::remove_file(&path).await;
        return Err(error);
    }
    pending.downloaded = Some(path);
    Ok(())
}

#[tauri::command]
pub async fn install_update(
    app: tauri::AppHandle,
    state: State<'_, Arc<AppState>>,
    updates: State<'_, UpdateManager>,
) -> Result<(), String> {
    if !cfg!(any(target_os = "windows", target_os = "macos")) {
        return Err("当前系统请前往发布页手动安装更新".to_string());
    }
    let guard = updates
        .pending
        .try_lock()
        .map_err(|_| "更新任务正在进行，请稍后重试")?;
    let pending = guard.as_ref().ok_or("请先检查更新")?;
    let path = pending.downloaded.as_ref().ok_or("请先下载安装包")?;
    if state.downloads.busy() || state.pdf.busy() {
        return Err("请等待漫画下载和 PDF 导出完成后再安装更新".to_string());
    }
    // Recheck just before execution so a modified cached file cannot be installed.
    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|_| "安装包已丢失，请重新检查更新并下载")?;
    let mut hash = Sha256::new();
    let mut size = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .await
            .map_err(|_| "无法读取安装包，请重新检查更新并下载")?;
        if count == 0 {
            break;
        }
        size += count as u64;
        if size > pending.asset.size {
            return Err("安装包已改变，请重新检查更新并下载".to_string());
        }
        hash.update(&buffer[..count]);
    }
    verify_installer(&pending.asset, size, &hex::encode(hash.finalize()))?;
    drop(file);
    match pending.kind {
        InstallerKind::Windows if cfg!(target_os = "windows") => {
            std::process::Command::new(path)
                .spawn()
                .map_err(|_| "无法启动安装程序，请重试或前往发布页手动安装")?;
        }
        InstallerKind::Macos if cfg!(target_os = "macos") => {
            app.opener()
                .open_path(path.to_string_lossy().into_owned(), None::<&str>)
                .map_err(|_| "无法打开安装包，请重试或前往发布页手动安装")?;
        }
        _ => return Err("安装包与当前系统不匹配，请重新检查更新".to_string()),
    }
    app.exit(0);
    Ok(())
}

#[tauri::command]
pub fn open_update_release(app: tauri::AppHandle) -> Result<(), String> {
    app.opener()
        .open_url(RELEASES_URL, None::<&str>)
        .map_err(|_| "无法打开浏览器，请访问 github.com/mkktop/copycopy/releases".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn release(version: &str) -> Release {
        serde_json::from_value(serde_json::json!({
            "tag_name": version, "body": "修复与改进", "assets": [{
                "name": "CopyCopy_0.2.0_x64-setup.exe",
                "browser_download_url": "https://github.com/mkktop/copycopy/releases/download/v0.2.0/Pika.Client_0.2.0_x64-setup.exe",
                "size": 3, "digest": format!("sha256:{}", hex::encode(Sha256::digest(b"abc")))
            }]
        })).unwrap()
    }

    #[test]
    fn compares_versions_semantically_and_ignores_build_metadata() {
        for (current, latest, available) in [
            ("0.2.0", "v0.10.0", true),
            ("0.10.0", "v0.2.0", false),
            ("0.2.0", "0.2.0", false),
            ("0.2.0", "v0.2.0+build.5", false),
            ("0.2.0-rc.1", "V0.2.0", true),
        ] {
            let (check, _) =
                evaluate_release(current, Some(release(latest)), "windows", "x86_64").unwrap();
            assert_eq!(
                matches!(check.status, UpdateStatus::Available),
                available,
                "{current} -> {latest}"
            );
        }
    }

    #[test]
    fn unpublished_and_prereleases_are_not_upgrades() {
        let (check, _) = evaluate_release("0.1.0", None, "windows", "x86_64").unwrap();
        assert!(matches!(check.status, UpdateStatus::Unpublished));
        for variant in ["draft", "prerelease", "semver"] {
            let mut next = release("v0.2.0");
            match variant {
                "draft" => next.draft = true,
                "prerelease" => next.prerelease = true,
                _ => next.tag_name = "v0.2.0-rc.1".to_string(),
            }
            let (check, pending) =
                evaluate_release("0.1.0", Some(next), "windows", "x86_64").unwrap();
            assert!(!check.can_install);
            assert!(pending.is_none());
        }
        assert!(evaluate_release("0.1.0", Some(release("latest")), "windows", "x86_64").is_err());
    }

    #[test]
    fn only_selects_matching_platform_and_verifiable_installers() {
        let next = release("v0.2.0");
        assert!(installer_for(&next, "windows", "x86_64").is_some());
        assert!(installer_for(&next, "linux", "x86_64").is_none());
        assert!(installer_for(&next, "windows", "aarch64").is_none());
        for variant in [
            "missing_digest",
            "bad_digest",
            "other_repo",
            "oversize",
            "empty",
            "wrong_extension",
        ] {
            let mut next = release("v0.2.0");
            let asset = &mut next.assets[0];
            match variant {
                "missing_digest" => asset.digest = None,
                "bad_digest" => asset.digest = Some("sha256:abc".to_string()),
                "other_repo" => {
                    asset.browser_download_url =
                        "https://github.com/other/repo/releases/download/v1/app.exe".to_string()
                }
                "oversize" => asset.size = MAX_INSTALLER_SIZE + 1,
                "empty" => asset.size = 0,
                _ => asset.name = "app.zip".to_string(),
            }
            let (check, pending) =
                evaluate_release("0.1.0", Some(next), "windows", "x86_64").unwrap();
            assert!(matches!(check.status, UpdateStatus::Available));
            assert!(!check.can_install, "{variant}");
            assert!(pending.is_none());
        }
    }

    #[test]
    fn mac_updates_select_universal_or_matching_architecture_dmg() {
        let mut next = release("v0.2.0");
        let mut universal = next.assets[0].clone();
        universal.name = "CopyCopy_0.2.0_universal.dmg".to_string();
        universal.browser_download_url = "https://github.com/mkktop/copycopy/releases/download/v0.2.0/Pika.Client_0.2.0_universal.dmg".to_string();
        next.assets.push(universal.clone());
        for arch in ["aarch64", "x86_64"] {
            let (asset, kind) = installer_for(&next, "macos", arch).unwrap();
            assert_eq!(asset.name, universal.name);
            assert_eq!(kind, InstallerKind::Macos);
            assert_eq!(kind.extension(), "dmg");
        }
        assert_eq!(
            installer_for(&next, "windows", "x86_64").unwrap().1,
            InstallerKind::Windows
        );
        assert!(installer_for(&next, "macos", "x86").is_none());
        let mut intel = universal;
        intel.name = "CopyCopy_0.2.0_x64.dmg".to_string();
        next.assets.push(intel.clone());
        assert_eq!(
            installer_for(&next, "macos", "x86_64").unwrap().0.name,
            intel.name
        );
        assert!(
            installer_for(&next, "macos", "aarch64")
                .unwrap()
                .0
                .name
                .ends_with("_universal.dmg")
        );
        let (check, pending) = evaluate_release("0.1.0", Some(next), "macos", "aarch64").unwrap();
        assert!(check.can_install);
        assert_eq!(check.installer_kind, Some(InstallerKind::Macos));
        assert!(pending.is_some());
    }

    #[test]
    fn arm64_only_mac_release_is_selected_for_apple_silicon() {
        let mut next = release("v0.2.2");
        let mut arm = next.assets[0].clone();
        arm.name = "CopyCopy_0.2.2_aarch64.dmg".to_string();
        arm.browser_download_url = "https://github.com/mkktop/copycopy/releases/download/v0.2.2/Pika.Client_0.2.2_aarch64.dmg".to_string();
        next.assets.push(arm.clone());
        assert_eq!(
            installer_for(&next, "macos", "aarch64").unwrap().0.name,
            arm.name
        );
        assert!(installer_for(&next, "macos", "x86_64").is_none());
        assert!(installer_for(&next, "windows", "x86_64").is_some());
        let (check, pending) = evaluate_release("0.2.1", Some(next), "macos", "aarch64").unwrap();
        assert!(check.can_install);
        assert_eq!(check.installer_kind, Some(InstallerKind::Macos));
        assert_eq!(pending.unwrap().asset.name, arm.name);
    }

    #[test]
    fn rejects_untrusted_download_urls() {
        for url in [
            "http://github.com/mkktop/copycopy/releases/download/v1/app.exe",
            "https://github.com.evil.test/mkktop/copycopy/releases/download/v1/app.exe",
            "https://evil.test/mkktop/copycopy/releases/download/v1/app.exe",
            "https://github.com@evil.test/mkktop/copycopy/releases/download/v1/app.exe",
            "https://github.com/mkktop/copycopy/releases/download/../../other/app.exe",
        ] {
            assert!(!trusted_download(url), "{url}");
        }
    }

    #[test]
    fn rejects_truncated_or_modified_installers() {
        let asset = &release("v0.2.0").assets[0];
        let correct = hex::encode(Sha256::digest(b"abc"));
        assert!(verify_installer(asset, 3, &correct).is_ok());
        assert!(verify_installer(asset, 2, &correct).is_err());
        assert!(verify_installer(asset, 3, &hex::encode(Sha256::digest(b"abd"))).is_err());
    }

    #[tokio::test]
    async fn downloads_and_verifies_the_response_before_marking_it_ready() {
        for (body, content_length, succeeds) in [
            (b"abc".as_slice(), 3, true),
            (b"ab".as_slice(), 3, false),
            (b"abd".as_slice(), 3, false),
            (b"abcd".as_slice(), 4, false),
        ] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = [0u8; 4096];
                socket.read(&mut request).await.unwrap();
                let header = format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {content_length}\r\nConnection: close\r\n\r\n"
                );
                socket.write_all(header.as_bytes()).await.unwrap();
                socket.write_all(body).await.unwrap();
            });
            let mut asset = release("v0.2.0").assets.remove(0);
            asset.browser_download_url = format!("http://{address}/installer");
            // Local test traffic only; production requests always use http_client's HTTPS policy.
            let client = Client::builder().no_proxy().build().unwrap();
            let path =
                std::env::temp_dir().join(format!("pika-updater-test-{}", uuid::Uuid::new_v4()));
            let channel = Channel::new(|_| Ok(()));
            let result = download_installer(&client, &asset, &path, &channel).await;
            server.await.unwrap();
            if succeeds {
                assert_eq!(tokio::fs::read(&path).await.unwrap(), body);
            }
            let _ = tokio::fs::remove_file(&path).await;
            assert_eq!(result.is_ok(), succeeds, "{body:?}: {result:?}");
        }
    }
}
