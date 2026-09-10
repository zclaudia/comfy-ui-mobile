use serde::de::DeserializeOwned;
use tauri::{plugin::PluginApi, AppHandle, Runtime};

use crate::models::{DownloadRequest, DownloadResponse, SaveJsonRequest, SaveJsonResponse};
use crate::{Error, Result};

pub struct MediaDownload<R: Runtime>(AppHandle<R>);

pub fn init<R: Runtime, C: DeserializeOwned>(
    app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> Result<MediaDownload<R>> {
    Ok(MediaDownload(app.clone()))
}

impl<R: Runtime> MediaDownload<R> {
    pub fn save_json_file(&self, _payload: SaveJsonRequest) -> Result<SaveJsonResponse> {
        Err(Error::UnsupportedPlatform)
    }
    pub fn enqueue_download(
        &self,
        _payload: DownloadRequest,
    ) -> Result<DownloadResponse> {
        Err(Error::UnsupportedPlatform)
    }
}
