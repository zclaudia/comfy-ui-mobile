use tauri::{command, AppHandle, Runtime};

use crate::models::{DownloadRequest, DownloadResponse, SaveJsonRequest, SaveJsonResponse};
use crate::{MediaDownloadExt, Result};

#[command]
pub(crate) async fn enqueue_download<R: Runtime>(
    app: AppHandle<R>,
    payload: DownloadRequest,
) -> Result<DownloadResponse> {
    app.media_download().enqueue_download(payload)
}

#[command]
pub(crate) async fn save_json_file<R: Runtime>(
    app: AppHandle<R>,
    payload: SaveJsonRequest,
) -> Result<SaveJsonResponse> {
    app.media_download().save_json_file(payload)
}
