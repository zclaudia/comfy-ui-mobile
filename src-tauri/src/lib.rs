#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_secure_credentials::init())
        .plugin(tauri_plugin_websocket::init())
        .run(tauri::generate_context!())
        .expect("error while running Comfy Mobile");
}
