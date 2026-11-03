# CopyCopy Desktop

基于 **Tauri 2 + Vue 3 + Rust** 全新设计的漫画桌面客户端。界面参考 [pika_client](https://github.com/mkktop/pika_client) 的暖白背景、深绿侧栏与橙色强调色，保留 CopyCopy 自己的书本标识。

## 功能

- 关键词与作者搜索，分页浏览作品和章节，跨页选章与区间下载。
- 图片并发下载、取消、重试、置顶与重启续传；只在完整下载后推进追更进度。
- SQLite 本地书库、缺页检查、批量章节管理与 PDF 导出，支持 AES-128 阅读密码。
- 在线与离线阅读、逐页和滚动模式、缩放、跨章导航与阅读进度。
- 追更订阅、启动/定时检查、单部作品的下载上限。
- 系统/直连/自定义代理，图片代理与磁盘缓存、系统通知。
- 正式版本检查、校验安装包、手动下载安装更新。

这是全新的客户端设计，不包含旧版兼容或数据迁移层。模型服务、广告识别、密钥管理及相关页面和依赖均已移除。

## 项目结构

- src：Vue 界面，components / views / stores / services 分层。
- src-tauri/src/api.rs：站点 API、客户端请求头、页序和图片验证。
- src-tauri/src/commands.rs：界面可调用的原生命令白名单。
- src-tauri/src/db.rs：SQLite 设置、书库、下载任务、订阅和阅读进度。
- src-tauri/src/download.rs：队列、取消、并发、断点续传及完成事件。
- src-tauri/src/library.rs / pdf.rs：本地文件与 PDF 导出。
- src-tauri/src/media.rs：受限图片协议、网络转发与缓存。
- src-tauri/src/updates.rs：正式发布检查、下载验证与安装。

数据默认存储在 Tauri 的应用数据目录（标识 com.copycopy.desktop）；可在「网络与存储」中选择漫画下载目录。

## 开发

需要 Node.js 24、Rust stable 和 [Tauri 系统依赖](https://v2.tauri.app/start/prerequisites/)。

    npm ci
    npm run tauri -- icon public/brand.svg --output src-tauri/icons
    npm run tauri dev

验证与打包：

    npm run build
    npm test
    cargo test --manifest-path src-tauri/Cargo.toml --lib
    npm run tauri -- build --bundles nsis

Linux 需要 WebKitGTK 4.1 开发包；Windows 运行环境使用 WebView2。CI 包含浏览器界面流程、Rust 本地模拟站点下载/PDF 测试以及真实 Windows WebView2 原生桥接验证。

## 正式发布

版本号在 package.json、Cargo.toml 与 tauri.conf.json 中一致。合并到 master 并推送匹配的稳定版本标签后，工作流运行检查、生成安装包并发布到 GitHub Releases。普通分支和 PR 仅提供构建产物，不自动发布。
