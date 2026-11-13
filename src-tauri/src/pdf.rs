use crate::models::PdfResult;
use lopdf::{
    Document, Object, Stream,
    content::{Content, Operation},
    dictionary,
};
use std::{
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};
use tokio::sync::Semaphore;

// 单张图片解码时允许的最大分配量（防止压缩炸弹）。
const MAX_IMAGE_ALLOC: u64 = 256 * 1024 * 1024;
// 单张图片的宽/高上限，避免极端尺寸撑爆内存。
const MAX_IMAGE_DIMENSION: u32 = 8192;
// 整章累计未压缩 RGB 字节预算，避免整章图片常驻内存导致 OOM。
const MAX_CHAPTER_PIXELS: u64 = 512 * 1024 * 1024;

pub struct PdfManager {
    active: Arc<AtomicUsize>,
    gate: Semaphore,
}
struct Active(Arc<AtomicUsize>);
impl Drop for Active {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}
impl PdfManager {
    pub fn new() -> Self {
        Self {
            active: Arc::new(AtomicUsize::new(0)),
            gate: Semaphore::new(1),
        }
    }
    pub fn busy(&self) -> bool {
        self.active.load(Ordering::SeqCst) > 0
    }
    pub async fn export(
        &self,
        root: PathBuf,
        dir: PathBuf,
        password: Option<String>,
    ) -> Result<PdfResult, String> {
        self.active.fetch_add(1, Ordering::SeqCst);
        let _active = Active(self.active.clone());
        let _permit = self
            .gate
            .acquire()
            .await
            .map_err(|_| "PDF 导出服务已关闭")?;
        tokio::task::spawn_blocking(move || generate(&root, &dir, password.as_deref()))
            .await
            .map_err(|e| e.to_string())?
    }
}
fn generate(root: &Path, dir: &Path, password: Option<&str>) -> Result<PdfResult, String> {
    let dir = crate::storage::inside(root, dir, false)?;
    let files = crate::storage::image_files(root, &dir)?;
    if files.is_empty() {
        return Err("章节中没有可导出的图片".into());
    }
    let mut doc = Document::with_version("1.7");
    let pages_id = doc.new_object_id();
    let mut page_ids = Vec::new();
    // 累计未压缩 RGB 字节数，超过预算立即中止，防止整章图片常驻内存。
    let mut chapter_bytes: u64 = 0;
    for file in &files {
        // 错误信息只回文件名，不泄露本地绝对路径。
        let name = file
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned();
        let bytes = std::fs::read(file).map_err(|e| e.to_string())?;
        if !crate::api::valid_image(&bytes) {
            return Err(format!("图片无法读取：{name}"));
        }
        // 用带 Limits 的解码器限制单张图片的分配量与尺寸，抵御解压炸弹。
        let mut reader = image::ImageReader::new(std::io::Cursor::new(&bytes))
            .with_guessed_format()
            .map_err(|_| format!("图片格式无法识别：{name}"))?;
        let mut limits = image::Limits::default();
        limits.max_alloc = Some(MAX_IMAGE_ALLOC);
        limits.max_image_width = Some(MAX_IMAGE_DIMENSION);
        limits.max_image_height = Some(MAX_IMAGE_DIMENSION);
        reader.limits(limits);
        let image = reader
            .decode()
            .map_err(|_| format!("图片尺寸过大或无法解码：{name}"))?;
        let (width, height) = (image.width(), image.height());
        let rgb_bytes = u64::from(width)
            .saturating_mul(u64::from(height))
            .saturating_mul(3);
        if rgb_bytes > MAX_CHAPTER_PIXELS.saturating_sub(chapter_bytes) {
            return Err(format!("章节图片过多，超过内存预算：{name}"));
        }
        chapter_bytes += rgb_bytes;
        let rgba = image.to_rgba8();
        let mut pixels = Vec::with_capacity(rgb_bytes as usize);
        for pixel in rgba.pixels() {
            let alpha = u16::from(pixel[3]);
            for channel in &pixel.0[..3] {
                pixels.push(((u16::from(*channel) * alpha + 255 * (255 - alpha)) / 255) as u8);
            }
        }
        // 立即 compress，避免未压缩 RGB 数据以明文常驻到 save_to。
        let mut stream = Stream::new(
            dictionary! {"Type"=>"XObject","Subtype"=>"Image","Width"=>width as i64,"Height"=>height as i64,"ColorSpace"=>"DeviceRGB","BitsPerComponent"=>8},
            pixels,
        );
        stream
            .compress()
            .map_err(|_| format!("图片压缩失败：{name}"))?;
        let image_id = doc.add_object(stream);
        let w = width as f32 * 0.75;
        let h = height as f32 * 0.75;
        let content = Content {
            operations: vec![
                Operation::new("q", vec![]),
                Operation::new(
                    "cm",
                    vec![w.into(), 0.into(), 0.into(), h.into(), 0.into(), 0.into()],
                ),
                Operation::new("Do", vec![Object::Name(b"PageImage".to_vec())]),
                Operation::new("Q", vec![]),
            ],
        };
        let content_id = doc.add_object(Stream::new(
            dictionary! {},
            content.encode().map_err(|e| e.to_string())?,
        ));
        let page_id=doc.add_object(dictionary!{"Type"=>"Page","Parent"=>pages_id,"Contents"=>content_id,"MediaBox"=>vec![0.into(),0.into(),w.into(),h.into()],"Resources"=>dictionary!{"XObject"=>dictionary!{"PageImage"=>image_id}}});
        page_ids.push(Object::Reference(page_id));
    }
    doc.objects.insert(
        pages_id,
        Object::Dictionary(
            dictionary! {"Type"=>"Pages","Kids"=>page_ids,"Count"=>files.len() as i64},
        ),
    );
    let catalog = doc.add_object(dictionary! {"Type"=>"Catalog","Pages"=>pages_id});
    doc.trailer.set("Root", catalog);
    let mut title = vec![0xfe, 0xff];
    for value in dir
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .encode_utf16()
    {
        title.extend_from_slice(&value.to_be_bytes());
    }
    let info=doc.add_object(dictionary!{"Producer"=>Object::string_literal("CopyCopy"),"Title"=>Object::String(title, lopdf::StringFormat::Hexadecimal)});
    doc.trailer.set("Info", info);
    doc.compress();
    let identifier = uuid::Uuid::new_v4().as_bytes().to_vec();
    doc.trailer.set(
        "ID",
        vec![
            Object::String(identifier.clone(), lopdf::StringFormat::Hexadecimal),
            Object::String(identifier, lopdf::StringFormat::Hexadecimal),
        ],
    );
    if let Some(password) = password.filter(|p| !p.is_empty()) {
        use lopdf::encryption::crypt_filters::{Aes128CryptFilter, CryptFilter};
        use lopdf::{EncryptionState, EncryptionVersion, Permissions};
        // owner 密码改为随机值，避免由 user 密码确定性派生而被推算绕过权限位。
        let owner = uuid::Uuid::new_v4().to_string();
        let filter: Arc<dyn CryptFilter> = Arc::new(Aes128CryptFilter);
        let encryption = EncryptionVersion::V4 {
            document: &doc,
            encrypt_metadata: true,
            crypt_filters: std::collections::BTreeMap::from([(b"StdCF".to_vec(), filter)]),
            stream_filter: b"StdCF".to_vec(),
            string_filter: b"StdCF".to_vec(),
            owner_password: &owner,
            user_password: password,
            permissions: Permissions::PRINTABLE
                | Permissions::COPYABLE
                | Permissions::COPYABLE_FOR_ACCESSIBILITY
                | Permissions::PRINTABLE_IN_HIGH_QUALITY,
        };
        let state = EncryptionState::try_from(encryption).map_err(|e| e.to_string())?;
        doc.encrypt(&state).map_err(|e| e.to_string())?;
    }
    let mut bytes = Vec::new();
    doc.save_to(&mut bytes).map_err(|e| e.to_string())?;
    let path = dir.parent().ok_or("章节目录无效")?.join(format!(
        "{}.pdf",
        dir.file_name().unwrap_or_default().to_string_lossy()
    ));
    crate::storage::atomic_write(&path, &bytes)?;
    Ok(PdfResult {
        path: path.to_string_lossy().into_owned(),
        pages: files.len(),
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn includes_every_page_and_preserves_password_protection() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let dir = root.join("test/第1.5话");
        std::fs::create_dir_all(&dir).unwrap();
        for page in 1..=3 {
            let image = image::RgbImage::from_pixel(100 + page, 180, image::Rgb([100, 120, 140]));
            image.save(dir.join(format!("{page:03}.png"))).unwrap();
        }
        let result = generate(root, &dir, None).unwrap();
        let path = result.path;
        assert_eq!(Document::load(&path).unwrap().get_pages().len(), 3);
        generate(root, &dir, Some("read-password")).unwrap();
        assert!(Document::load_with_password(&path, "wrong-password").is_err());
        let doc = Document::load_with_password(&path, "read-password").unwrap();
        assert_eq!(doc.get_pages().len(), 3);
    }
}
