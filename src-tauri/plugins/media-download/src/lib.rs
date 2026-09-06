use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

#[cfg(desktop)]
mod desktop;
#[cfg(mobile)]
mod mobile;

mod commands;
mod error;
mod models;

pub use error::{Error, Result};

#[cfg(desktop)]
use desktop::MediaDownload;
#[cfg(mobile)]
use mobile::MediaDownload;

pub trait MediaDownloadExt<R: Runtime> {
    fn media_download(&self) -> &MediaDownload<R>;
}

impl<R: Runtime, T: Manager<R>> MediaDownloadExt<R> for T {
    fn media_download(&self) -> &MediaDownload<R> {
        self.state::<MediaDownload<R>>().inner()
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("media-download")
        .invoke_handler(tauri::generate_handler![commands::enqueue_download])
        .setup(|app, api| {
            #[cfg(mobile)]
            let media_download = mobile::init(app, api)?;
            #[cfg(desktop)]
            let media_download = desktop::init(app, api)?;
            app.manage(media_download);
            Ok(())
        })
        .build()
}
