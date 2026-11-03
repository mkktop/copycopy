/// Tauri encodes the entire custom-protocol path on all desktop platforms.
/// Decode exactly once before separating the route from its URL or absolute path.
pub fn parse_image_uri(uri: &str) -> Result<(String, String), &'static str> {
    let rest = uri
        .strip_prefix("http://copyimg.localhost/")
        .or_else(|| uri.strip_prefix("https://copyimg.localhost/"))
        .or_else(|| uri.strip_prefix("copyimg://localhost/"))
        .ok_or("bad scheme")?;
    let decoded = urlencoding::decode(rest).map_err(|_| "bad encoding")?;
    let (kind, target) = decoded.split_once('/').ok_or("bad request")?;
    if target.is_empty() || !["remote", "local"].contains(&kind.to_ascii_lowercase().as_str()) {
        return Err("bad route");
    }
    Ok((kind.to_ascii_lowercase(), target.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_tauri_urls_on_windows_and_macos_without_losing_encoding() {
        for (kind, target) in [
            (
                "remote",
                "https://images.example.test/static/封面%20一.png?size=100&token=a%2Fb",
            ),
            ("local", "/Users/reader/漫画/100%20/第 1 页.png"),
            ("local", "C:\\Books\\漫画\\100%20\\第 1 页.png"),
        ] {
            let encoded = urlencoding::encode(&format!("{kind}/{target}")).into_owned();
            for base in [
                "http://copyimg.localhost/",
                "https://copyimg.localhost/",
                "copyimg://localhost/",
            ] {
                assert_eq!(
                    parse_image_uri(&format!("{base}{encoded}")).unwrap(),
                    (kind.to_string(), target.to_string())
                );
            }
        }
    }

    #[test]
    fn preserves_local_reader_identifiers_and_page_numbers() {
        let target = r#"{"comicId":"故事100%","chapterId":"第1话","page":2}"#;
        let uri = format!("http://copyimg.localhost/{}", urlencoding::encode(&format!("local/{target}")));
        assert_eq!(parse_image_uri(&uri).unwrap(), ("local".into(), target.into()));
    }

    #[test]
    fn rejects_unknown_origins_routes_and_invalid_encoding() {
        for uri in [
            "https://other.example/local/file.png",
            "copyimg://localhost/local",
            "copyimg://localhost/local/",
            "copyimg://localhost/execute%2Ffile",
            "copyimg://localhost/local%2F%FF",
        ] {
            assert!(parse_image_uri(uri).is_err(), "{uri}");
        }
    }
}
