fn main() {
    if let Err(error) = tauri_build::try_build(tauri_build::Attributes::default()) {
        eprintln!("tauri_build::try_build failed:\n{error:?}");
        std::process::exit(1);
    }
}
