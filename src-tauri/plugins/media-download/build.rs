const COMMANDS: &[&str] = &["enqueue_download"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
