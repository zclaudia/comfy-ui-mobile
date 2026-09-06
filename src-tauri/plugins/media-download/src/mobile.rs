use serde::de::DeserializeOwned;
use tauri::{
    plugin::{PluginApi, PluginHandle},
    AppHandle, Runtime,
};

use crate::models::{DownloadRequest, DownloadResponse};

pub struct MediaDownload<R: Runtime>(PluginHandle<R>);

pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> crate::Result<MediaDownload<R>> {
    #[cfg(target_os = "android")]
    let handle = api.register_android_plugin(
        "app.comfymobile.mediadownload",
        "MediaDownloadPlugin",
    )?;
    Ok(MediaDownload(handle))
}

impl<R: Runtime> MediaDownload<R> {
    pub fn enqueue_download(
        &self,
        payload: DownloadRequest,
    ) -> crate::Result<DownloadResponse> {
        self.0
            .run_mobile_plugin("enqueueDownload", payload)
            .map_err(Into::into)
    }
}
