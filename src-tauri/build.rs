fn main() {
    // Tauri 的 invoke 分发（generate_handler!）会把命令的 future 内联进同一条
    // 调用链，主线程默认 1MB 栈在核对安装包这类命令上会栈溢出（0xC00000FD），
    // 表现为点「退出并安装」后进程直接消失、安装程序却没有启动。
    // 预留 8MB 主线程栈：只占虚拟地址空间，实际按需提交。
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc")
    {
        println!("cargo:rustc-link-arg=/STACK:8388608");
    }
    tauri_build::build()
}
