const COMMANDS: &[&str] = &["enqueue_download", "save_json_file"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
