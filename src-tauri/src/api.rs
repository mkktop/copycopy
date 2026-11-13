use reqwest::{
    Client, Url,
    redirect::Policy,
};
use serde_json::Value;
use std::{
    net::{IpAddr, SocketAddr},
    sync::{Arc, RwLock},
    time::Duration,
};

#[derive(Clone)]
pub struct MangaClient {
    base: Url,
    client: Arc<RwLock<Client>>,
    proxy: Arc<RwLock<Option<String>>>,
}
#[derive(Debug)]
pub struct ChapterPages {
    pub comic_name: String,
    pub urls: Vec<String>,
}
fn client_for(proxy: Option<&str>) -> Result<Client, String> {
    let mut builder = Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(30))
        // JSON/API requests never follow redirects; images use a per-request
        // client with manual, validated redirects (see `image_client_for`).
        .redirect(Policy::none());
    apply_proxy(&mut builder, proxy)?;
    builder.build().map_err(|_| "无法初始化网络连接".into())
}
fn apply_proxy(builder: &mut reqwest::ClientBuilder, proxy: Option<&str>) -> Result<(), String> {
    if let Some(proxy) = proxy {
        if proxy.trim().is_empty() {
            *builder = std::mem::replace(builder, Client::builder()).no_proxy();
        } else {
            let url = Url::parse(proxy).map_err(|_| "代理地址无效")?;
            if !["http", "https", "socks5", "socks5h"].contains(&url.scheme())
                || url.host_str().is_none()
            {
                return Err("代理地址仅支持 HTTP、HTTPS 或 SOCKS5".into());
            }
            *builder = std::mem::replace(builder, Client::builder())
                .proxy(reqwest::Proxy::all(proxy).map_err(|_| "代理地址无效")?);
        }
    }
    Ok(())
}
/// Synchronous, DNS-free part of image URL validation. Kept public-compatible
/// via `MangaClient::validate_image_url` for callers that only need syntactic
/// checks; `image()` additionally performs the async DNS/SSRF check.
fn validate_image_url_syntax(base: &Url, source: &str) -> Result<Url, String> {
    let url = base.join(source).map_err(|_| "图片地址无效")?;
    if !["http", "https"].contains(&url.scheme())
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("图片地址协议无效".into());
    }
    // Explicit test/developer API overrides may use a loopback fixture. Keep
    // this origin pass-through before the private-IP checks (wiremock binds to
    // 127.0.0.1); every other host still goes through the full SSRF checks.
    if url.origin() == base.origin() {
        return Ok(url);
    }
    let host = url
        .host_str()
        .ok_or("图片地址缺少域名")?
        .trim_matches(['[', ']'])
        .to_lowercase();
    if host == "localhost"
        || host.ends_with(".localhost")
        || host.ends_with(".local")
        || host.ends_with(".internal")
        || host.ends_with(".home.arpa")
        || host.ends_with(".lan")
        || !host.contains('.') && host.parse::<IpAddr>().is_err()
    {
        return Err("不允许访问本地图片地址".into());
    }
    if let Ok(ip) = host.parse::<IpAddr>() {
        if blocked_ip(&ip) {
            return Err("不允许访问内网图片地址".into());
        }
    }
    Ok(url)
}
/// True for any IP that must never be reached for remote images (loopback,
/// private, link-local, metadata, CGNAT, multicast, etc.). Also used for every
/// resolved DNS answer in `validated_socket_addrs`.
fn blocked_ip(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            ip.is_private()
                || ip.is_loopback()
                || ip.is_link_local()
                || ip.is_unspecified()
                || ip.is_broadcast()
                || ip.is_multicast()
                || ip.octets()[0] == 0
                || ip.octets()[0] == 100 && (64..=127).contains(&ip.octets()[1])
        }
        IpAddr::V6(ip) => {
            ip.is_loopback()
                || ip.is_unspecified()
                || ip.is_multicast()
                || ip.is_unique_local()
                || ip.is_unicast_link_local()
                || ip
                    .to_ipv4_mapped()
                    .is_some_and(|v| v.is_private() || v.is_loopback() || v.is_link_local())
        }
    }
}
impl MangaClient {
    pub fn new(proxy: Option<String>) -> Result<Self, String> {
        let host =
            std::env::var("COPYCOPY_API_HOST").unwrap_or_else(|_| "api.mangacopy.com".into());
        let base =
            std::env::var("COPYCOPY_API_BASE").unwrap_or_else(|_| format!("https://{host}/"));
        Self::with_base(&base, proxy)
    }
    pub fn with_base(base: &str, proxy: Option<String>) -> Result<Self, String> {
        Ok(Self {
            base: Url::parse(base).map_err(|_| "接口地址无效")?,
            client: Arc::new(RwLock::new(client_for(proxy.as_deref())?)),
            proxy: Arc::new(RwLock::new(proxy)),
        })
    }
    pub fn proxy(&self) -> Option<String> {
        self.proxy.read().unwrap_or_else(|e| e.into_inner()).clone()
    }
    pub fn set_proxy(&self, proxy: Option<String>) -> Result<(), String> {
        let client = client_for(proxy.as_deref())?;
        *self.client.write().map_err(|_| "网络设置繁忙")? = client;
        *self.proxy.write().map_err(|_| "网络设置繁忙")? = proxy;
        Ok(())
    }
    fn headers(&self, image: bool) -> reqwest::header::HeaderMap {
        use reqwest::header::{ACCEPT, HeaderMap, HeaderValue, USER_AGENT};
        let mut h = HeaderMap::new();
        h.insert(USER_AGENT, HeaderValue::from_static("COPY/4.0.0"));
        h.insert(
            ACCEPT,
            HeaderValue::from_static(if image { "image/*" } else { "application/json" }),
        );
        let version = std::env::var("COPYCOPY_API_VERSION").unwrap_or_else(|_| "2026.10.10".into());
        if let Ok(value) = HeaderValue::from_str(&version) {
            h.insert("version", value);
        }
        for (key, value) in [("platform", "1"), ("region", "1")] {
            h.insert(key, HeaderValue::from_static(value));
        }
        if !image {
            h.insert("webp", HeaderValue::from_static("1"));
        }
        h
    }
    fn url(&self, segments: &[&str]) -> Result<Url, String> {
        let mut url = self.base.clone();
        {
            let mut path = url.path_segments_mut().map_err(|_| "接口地址无效")?;
            path.clear();
            for segment in segments {
                path.push(segment);
            }
        }
        Ok(url)
    }
    async fn request(&self, url: Url) -> Result<Value, String> {
        let client = { self.client.read().map_err(|_| "网络繁忙")?.clone() };
        let response = client
            .get(url)
            .headers(self.headers(false))
            .send()
            .await
            .map_err(|_| "无法连接漫画站点，请检查网络和代理设置")?;
        let status = response.status();
        let body: Value = response
            .json()
            .await
            .map_err(|_| format!("站点返回无法读取的内容（HTTP {status}）"))?;
        if !status.is_success() || body["code"].as_i64() != Some(200) {
            return Err(format!(
                "HTTP {}：{}",
                status.as_u16(),
                body["message"].as_str().unwrap_or("站点请求失败")
            ));
        }
        body.get("results")
            .filter(|v| !v.is_null())
            .cloned()
            .ok_or_else(|| "接口未返回结果".into())
    }
    pub async fn search(&self, keyword: &str, page: u64, kind: &str) -> Result<Value, String> {
        let mut url = self.url(&["api", "v3", "search", "comic"])?;
        let kind = if ["", "name", "author"].contains(&kind) {
            kind
        } else {
            ""
        };
        url.query_pairs_mut()
            .append_pair("limit", "24")
            .append_pair("offset", &((page.clamp(1, 100000) - 1) * 24).to_string())
            .append_pair("q", keyword)
            .append_pair("q_type", kind)
            .append_pair("platform", "1");
        self.request(url).await
    }
    pub async fn comic(&self, path: &str) -> Result<Value, String> {
        let mut url = self.url(&["api", "v3", "comic2", path])?;
        url.query_pairs_mut().append_pair("platform", "1");
        self.request(url)
            .await?
            .get("comic")
            .filter(|c| !c.is_null())
            .cloned()
            .ok_or_else(|| "接口未返回漫画信息".into())
    }
    pub async fn chapters(&self, path: &str, page: u64) -> Result<Value, String> {
        let mut url = self.url(&["api", "v3", "comic", path, "group", "default", "chapters"])?;
        url.query_pairs_mut()
            .append_pair("limit", "50")
            .append_pair("offset", &((page.clamp(1, 100000) - 1) * 50).to_string());
        self.request(url).await
    }
    pub async fn pages(&self, path: &str, uuid: &str) -> Result<ChapterPages, String> {
        let value = self
            .request(self.url(&["api", "v3", "comic", path, "chapter2", uuid])?)
            .await?;
        ordered_pages(&self.base, value, path)
    }
    pub fn validate_image_url(&self, source: &str) -> Result<Url, String> {
        // Synchronous syntax/blacklist check for callers that don't fetch.
        // The same-origin fixture pass-through lives in the helper; `image()`
        // additionally runs the async DNS/SSRF check on every real hop.
        validate_image_url_syntax(&self.base, source)
    }
    /// Async SSRF check: resolve every address for the host, reject private
    /// ranges, and return the validated socket addresses so the connection can
    /// be pinned (`.resolve`) to prevent DNS rebinding between check and use.
    /// Same-origin fixtures (wiremock in tests) are allowed without DNS.
    async fn validated_socket_addrs(&self, url: &Url) -> Result<Vec<SocketAddr>, String> {
        let host = url
            .host_str()
            .ok_or("图片地址缺少域名")?
            .trim_matches(['[', ']'])
            .to_ascii_lowercase();
        let port = url
            .port_or_known_default()
            .ok_or("图片地址协议无效")?;
        // Local fixtures share the API origin; preserve the historical
        // pass-through (wiremock binds to loopback) and just return the
        // resolved addresses for pinning.
        if url.origin() == self.base.origin() {
            return Ok(tokio::net::lookup_host((host.as_str(), port))
                .await
                .map_err(|_| "图片地址解析失败")?
                .collect::<Vec<_>>());
        }
        if let Ok(ip) = host.parse::<IpAddr>() {
            if blocked_ip(&ip) {
                return Err("不允许访问内网图片地址".into());
            }
            return Ok(vec![SocketAddr::new(ip, port)]);
        }
        let addrs = tokio::net::lookup_host((host.as_str(), port))
            .await
            .map_err(|_| "图片地址解析失败")?
            .collect::<Vec<_>>();
        if addrs.is_empty() || addrs.iter().any(|a| blocked_ip(&a.ip())) {
            return Err("不允许访问内网图片地址".into());
        }
        Ok(addrs)
    }
    fn image_client_for(&self, url: &Url, addrs: &[SocketAddr]) -> Result<Client, String> {
        let host = url
            .host_str()
            .ok_or("图片地址缺少域名")?
            .trim_matches(['[', ']'])
            .to_ascii_lowercase();
        let proxy = self.proxy.read().map_err(|_| "网络繁忙")?.clone();
        let mut builder = Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(30))
            // Manual, validated redirects; never let reqwest follow on its own.
            .redirect(Policy::none())
            .resolve_to_addrs(&host, addrs);
        apply_proxy(&mut builder, proxy.as_deref())?;
        builder.build().map_err(|_| "无法初始化网络连接".into())
    }
    pub async fn image(&self, source: &str) -> Result<Vec<u8>, String> {
        // Manual, bounded redirects: every hop is fully re-validated (syntax +
        // async DNS/SSRF) and re-pinned, so a CDN 302 to a private host can't
        // slip through. The global JSON client stays on Policy::none().
        let mut current = self.validate_image_url(source)?;
        for hop in 0..=3 {
            let addrs = self.validated_socket_addrs(&current).await?;
            let client = self.image_client_for(&current, &addrs)?;
            let mut response = client
                .get(current.clone())
                .headers(self.headers(true))
                .send()
                .await
                .map_err(|_| "图片连接失败")?;
            let status = response.status();
            if status.is_redirection() {
                if hop == 3 {
                    return Err("图片重定向次数过多".into());
                }
                let location = response
                    .headers()
                    .get(reqwest::header::LOCATION)
                    .and_then(|v| v.to_str().ok())
                    .ok_or("图片重定向地址无效")?;
                // Resolve relative Location against the current URL, then run
                // the full synchronous + async validation on the next hop.
                let next = current
                    .join(location)
                    .map_err(|_| "图片重定向地址无效")?;
                current = validate_image_url_syntax(&self.base, next.as_str())?;
                continue;
            }
            if !status.is_success() {
                return Err(format!("图片请求失败：HTTP {}", response.status()));
            }
            let mut bytes = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(|_| "图片下载中断")? {
                if bytes.len() + chunk.len() > 32 * 1024 * 1024 {
                    return Err("图片超过 32 MB，已停止下载".into());
                }
                bytes.extend_from_slice(&chunk);
            }
            if !valid_image(&bytes) {
                return Err("站点返回的内容不是有效图片".into());
            }
            return Ok(bytes);
        }
        Err("图片重定向次数过多".into())
    }
}
pub fn valid_image(bytes: &[u8]) -> bool {
    image::ImageReader::new(std::io::Cursor::new(bytes))
        .with_guessed_format()
        .ok()
        .and_then(|r| r.into_dimensions().ok())
        .is_some_and(|(w, h)| w > 0 && h > 0 && u64::from(w) * u64::from(h) <= 100_000_000)
}
pub fn ordered_pages(base: &Url, value: Value, fallback: &str) -> Result<ChapterPages, String> {
    let contents = value["chapter"]["contents"]
        .as_array()
        .ok_or("该章节没有可用页面")?;
    let words = value["chapter"]["words"]
        .as_array()
        .filter(|v| !v.is_empty());
    let indexes: Vec<usize> = match words {
        Some(words) => words
            .iter()
            .map(|v| v.as_u64().map(|v| v as usize).ok_or("页序数据无效"))
            .collect::<Result<_, _>>()?,
        None => (0..contents.len()).collect(),
    };
    let urls = indexes
        .into_iter()
        .map(|i| {
            let source = contents
                .get(i)
                .and_then(|v| v["url"].as_str())
                .ok_or("章节页表不完整")?;
            base.join(source)
                .map(|u| u.to_string())
                .map_err(|_| "图片地址无效")
        })
        .collect::<Result<Vec<_>, _>>()?;
    if urls.is_empty() {
        return Err("该章节没有可用页面".into());
    }
    Ok(ChapterPages {
        comic_name: value["comic"]["name"]
            .as_str()
            .unwrap_or(fallback)
            .to_string(),
        urls,
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    fn png_bytes(w: u32, h: u32) -> Vec<u8> {
        let mut bytes = Vec::new();
        image::RgbImage::from_pixel(w, h, image::Rgb([1, 2, 3]))
            .write_to(&mut std::io::Cursor::new(&mut bytes), image::ImageFormat::Png)
            .unwrap();
        bytes
    }
    #[test]
    fn restores_words_order_and_absolute_urls() {
        let result = ordered_pages(
            &Url::parse("https://api.example.test/").unwrap(),
            serde_json::json!({
                "chapter":{"contents":[{"url":"img/2.jpg"},{"url":"img/1.jpg"}],"words":[1,0]},
                "comic":{"name":"旅程 100%"}
            }),
            "fallback",
        )
        .unwrap();
        assert_eq!(
            result.urls,
            [
                "https://api.example.test/img/1.jpg",
                "https://api.example.test/img/2.jpg"
            ]
        );
        assert!(
            ordered_pages(
                &Url::parse("https://a.test/").unwrap(),
                serde_json::json!({"chapter":{"contents":[],"words":[99]}}),
                ""
            )
            .is_err()
        );
    }
    #[test]
    fn rejects_private_remote_images_and_invalid_content() {
        let client =
            MangaClient::with_base("https://api.example.test/", Some(String::new())).unwrap();
        for url in [
            "http://127.0.0.1/a",
            "http://[::1]/a",
            "http://[::ffff:127.0.0.1]/a",
            "http://10.1.2.3/a",
            "http://169.254.169.254/a",
            "http://printer.local/a",
            "file:///etc/passwd",
        ] {
            assert!(client.validate_image_url(url).is_err(), "{url}");
        }
        assert!(!valid_image(b"<html>error</html>"));
        assert!(
            client
                .validate_image_url("https://cdn.example.test/a.jpg")
                .is_ok()
        );
    }
    #[test]
    fn rejects_internal_and_lan_suffixes_and_blocks_private_ips() {
        let client =
            MangaClient::with_base("https://api.example.test/", Some(String::new())).unwrap();
        for url in [
            "https://nas.home.arpa/cover.jpg",
            "https://printer.internal/a.png",
            "https://box.lan/a.webp",
            "http://192.168.1.1/a",
            "http://172.16.0.1/a",
            "http://100.64.0.1/a",
            "http://[fd00::1]/a",
        ] {
            assert!(client.validate_image_url(url).is_err(), "{url}");
        }
        // Every resolved DNS answer is checked with the same predicate.
        for ip in [
            "10.0.0.1",
            "127.0.0.1",
            "169.254.169.254",
            "0.0.0.0",
            "224.0.0.1",
            "100.100.0.1",
            "::1",
            "fd12:3456::1",
            "fe80::1",
            "::ffff:10.0.0.1",
        ] {
            assert!(blocked_ip(&ip.parse().unwrap()), "{ip}");
        }
        for ip in ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"] {
            assert!(!blocked_ip(&ip.parse().unwrap()), "{ip}");
        }
    }
    #[tokio::test]
    async fn follows_validated_image_redirects_and_rejects_private_hops() {
        use wiremock::{
            Mock, MockServer, ResponseTemplate,
            matchers::{method, path},
        };
        let server = MockServer::start().await;
        let image = png_bytes(4, 4);
        Mock::given(method("GET"))
            .and(path("/start.jpg"))
            .respond_with(
                ResponseTemplate::new(302)
                    .insert_header("Location", &format!("{}/final.png", server.uri())),
            )
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/final.png"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(image.clone()))
            .mount(&server)
            .await;
        let client = MangaClient::with_base(&server.uri(), Some(String::new())).unwrap();
        // The fixture origin is same-origin, so the 302 chain is allowed and
        // the final bytes are validated as a real image.
        assert_eq!(
            client
                .image(&format!("{}/start.jpg", server.uri()))
                .await
                .unwrap(),
            image
        );
        // A redirect that lands on a private address is rejected before fetch.
        Mock::given(method("GET"))
            .and(path("/evil.jpg"))
            .respond_with(
                ResponseTemplate::new(302).insert_header("Location", "http://127.0.0.1:9/a.png"),
            )
            .mount(&server)
            .await;
        assert!(
            client
                .image(&format!("{}/evil.jpg", server.uri()))
                .await
                .is_err()
        );
    }
    #[tokio::test]
    async fn surfaces_site_errors_and_sends_current_client_headers() {
        use wiremock::{
            Mock, MockServer, ResponseTemplate,
            matchers::{header, method, path},
        };
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/v3/search/comic"))
            .and(header("user-agent", "COPY/4.0.0"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({"code":210,"message":"请更新最新APP"})),
            )
            .mount(&server)
            .await;
        let client = MangaClient::with_base(&server.uri(), Some(String::new())).unwrap();
        assert!(
            client
                .search("test", 1, "")
                .await
                .unwrap_err()
                .contains("请更新最新APP")
        );
    }
}

pub fn comic_model(value: &Value, fallback: &str) -> crate::models::Comic {
    crate::models::Comic {
        id: value["path_word"].as_str().unwrap_or(fallback).into(),
        title: value["name"].as_str().unwrap_or(fallback).into(),
        alias: value["alias"].as_str().unwrap_or("").into(),
        cover: value["cover"].as_str().unwrap_or("").into(),
        authors: value["author"]
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter_map(|a| a["name"].as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default(),
        description: value["brief"].as_str().unwrap_or("").into(),
        updated_at: value["datetime_updated"].as_str().unwrap_or("").into(),
        latest_chapter: value["last_chapter"]["name"].as_str().unwrap_or("").into(),
    }
}
pub fn search_page(
    value: Value,
    page: u64,
) -> Result<crate::models::Page<crate::models::Comic>, String> {
    let items = value["list"]
        .as_array()
        .ok_or("搜索结果格式无效")?
        .iter()
        .map(|v| comic_model(v, ""))
        .collect();
    Ok(crate::models::Page {
        items,
        total: value["total"].as_u64().unwrap_or(0),
        page,
        page_size: 24,
    })
}
pub fn chapter_page(
    value: Value,
    page: u64,
) -> Result<crate::models::Page<crate::models::Chapter>, String> {
        let offset = value["offset"]
            .as_u64()
            .unwrap_or_else(|| (page.saturating_sub(1)).saturating_mul(50));
    let items = value["list"]
        .as_array()
        .ok_or("章节列表格式无效")?
        .iter()
        .enumerate()
        .map(|(i, v)| crate::models::Chapter {
            id: v["uuid"].as_str().unwrap_or("").into(),
            title: v["name"].as_str().unwrap_or("").into(),
            index: offset.saturating_add(i as u64).saturating_add(1),
            page_count: v["size"].as_u64().unwrap_or(0),
            updated_at: v["datetime_created"].as_str().unwrap_or("").into(),
        })
        .collect();
    Ok(crate::models::Page {
        items,
        total: value["total"].as_u64().unwrap_or(0),
        page,
        page_size: 50,
    })
}
