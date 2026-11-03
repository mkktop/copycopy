use crate::models::PdfResult;
use lopdf::{Document, Object, Stream, dictionary, content::{Content, Operation}};
use std::{path::{Path, PathBuf}, sync::{Arc, atomic::{AtomicUsize,Ordering}}};
use tokio::sync::Semaphore;

pub struct PdfManager { active: Arc<AtomicUsize>, gate: Semaphore }
struct Active(Arc<AtomicUsize>);
impl Drop for Active { fn drop(&mut self) { self.0.fetch_sub(1, Ordering::SeqCst); } }
impl PdfManager {
    pub fn new() -> Self { Self { active:Arc::new(AtomicUsize::new(0)), gate:Semaphore::new(1) } }
    pub fn busy(&self) -> bool { self.active.load(Ordering::SeqCst) > 0 }
    pub async fn export(&self, root:PathBuf, dir:PathBuf, password:Option<String>) -> Result<PdfResult,String> {
        self.active.fetch_add(1, Ordering::SeqCst); let _active=Active(self.active.clone());
        let _permit=self.gate.acquire().await.map_err(|_|"PDF 导出服务已关闭")?;
        tokio::task::spawn_blocking(move||generate(&root,&dir,password.as_deref())).await.map_err(|e|e.to_string())?
    }
}
fn generate(root:&Path, dir:&Path, password:Option<&str>) -> Result<PdfResult,String> {
    let dir=crate::storage::inside(root,dir,false)?;
    let files=crate::storage::image_files(root,&dir)?;
    if files.is_empty() { return Err("章节中没有可导出的图片".into()); }
    let mut doc=Document::with_version("1.7");
    let pages_id=doc.new_object_id(); let mut page_ids=Vec::new();
    for file in &files {
        let bytes=std::fs::read(file).map_err(|e|e.to_string())?;
        if !crate::api::valid_image(&bytes) { return Err(format!("图片无法读取：{}",file.display())); }
        let image=image::load_from_memory(&bytes).map_err(|e|e.to_string())?;
        let (width,height)=(image.width(),image.height());
        let rgba=image.to_rgba8(); let mut pixels=Vec::with_capacity(width as usize*height as usize*3);
        for pixel in rgba.pixels() {
            let alpha=u16::from(pixel[3]);
            for channel in &pixel.0[..3] { pixels.push(((u16::from(*channel)*alpha+255*(255-alpha))/255) as u8); }
        }
        let mut stream=Stream::new(dictionary!{"Type"=>"XObject","Subtype"=>"Image","Width"=>width as i64,"Height"=>height as i64,"ColorSpace"=>"DeviceRGB","BitsPerComponent"=>8},pixels);
        stream.compress().map_err(|e|e.to_string())?;
        let image_id=doc.add_object(stream);
        let w=width as f32*0.75; let h=height as f32*0.75;
        let content=Content{operations:vec![Operation::new("q",vec![]),Operation::new("cm",vec![w.into(),0.into(),0.into(),h.into(),0.into(),0.into()]),Operation::new("Do",vec![Object::Name(b"PageImage".to_vec())]),Operation::new("Q",vec![])]};
        let content_id=doc.add_object(Stream::new(dictionary!{},content.encode().map_err(|e|e.to_string())?));
        let page_id=doc.add_object(dictionary!{"Type"=>"Page","Parent"=>pages_id,"Contents"=>content_id,"MediaBox"=>vec![0.into(),0.into(),w.into(),h.into()],"Resources"=>dictionary!{"XObject"=>dictionary!{"PageImage"=>image_id}}});
        page_ids.push(Object::Reference(page_id));
    }
    doc.objects.insert(pages_id,Object::Dictionary(dictionary!{"Type"=>"Pages","Kids"=>page_ids,"Count"=>files.len() as i64}));
    let catalog=doc.add_object(dictionary!{"Type"=>"Catalog","Pages"=>pages_id}); doc.trailer.set("Root",catalog);
    let info=doc.add_object(dictionary!{"Producer"=>Object::string_literal("CopyCopy"),"Title"=>Object::string_literal(dir.file_name().unwrap_or_default().to_string_lossy().as_bytes())});
    doc.trailer.set("Info",info); doc.compress();
    if let Some(password)=password.filter(|p|!p.is_empty()&&*p!="None") {
        use lopdf::{EncryptionState,EncryptionVersion,Permissions};
        use lopdf::encryption::crypt_filters::{Aes128CryptFilter,CryptFilter};
        use sha2::{Digest,Sha256};
        let owner=hex::encode(Sha256::digest(format!("copycopy-owner:{password}").as_bytes()));
        let filter:Arc<dyn CryptFilter>=Arc::new(Aes128CryptFilter);
        let encryption=EncryptionVersion::V4{document:&doc,encrypt_metadata:true,crypt_filters:std::collections::BTreeMap::from([(b"StdCF".to_vec(),filter)]),stream_filter:b"StdCF".to_vec(),string_filter:b"StdCF".to_vec(),owner_password:&owner,user_password:password,permissions:Permissions::PRINTABLE|Permissions::COPYABLE|Permissions::COPYABLE_FOR_ACCESSIBILITY|Permissions::PRINTABLE_IN_HIGH_QUALITY};
        let state=EncryptionState::try_from(encryption).map_err(|e|e.to_string())?;
        doc.encrypt(&state).map_err(|e|e.to_string())?;
    }
    let mut bytes=Vec::new(); doc.save_to(&mut bytes).map_err(|e|e.to_string())?;
    let path=dir.parent().ok_or("章节目录无效")?.join(format!("{}.pdf",dir.file_name().unwrap_or_default().to_string_lossy()));
    crate::storage::atomic_write(&path,&bytes)?;
    Ok(PdfResult{path:path.to_string_lossy().into_owned(),pages:files.len()})
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn includes_every_page_and_preserves_password_protection() {
        let temp=tempfile::tempdir().unwrap(); let root=temp.path(); let dir=root.join("test/第1.5话");std::fs::create_dir_all(&dir).unwrap();
        for page in 1..=3 {
            let image=image::RgbImage::from_pixel(100+page,180,image::Rgb([100,120,140]));
            image.save(dir.join(format!("{page:03}.png"))).unwrap();
        }
        let result=generate(root,&dir,None).unwrap(); let path=result.path;
        assert_eq!(Document::load(&path).unwrap().get_pages().len(),3);
        generate(root,&dir,Some("read-password")).unwrap();
        let mut doc=Document::load(&path).unwrap();
        assert!(doc.is_encrypted()); assert!(doc.decrypt("wrong-password").is_err());
        doc.decrypt("read-password").unwrap(); assert_eq!(doc.get_pages().len(),3);
    }
}
