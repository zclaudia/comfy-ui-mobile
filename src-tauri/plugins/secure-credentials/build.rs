const COMMANDS: &[&str] = &["get_secret", "remove_secret", "set_secret"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
