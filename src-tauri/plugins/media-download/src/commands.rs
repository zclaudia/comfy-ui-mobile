use tauri::{command, AppHandle, Runtime};

use crate::models::{DownloadRequest, DownloadResponse};
use crate::{MediaDownloadExt, Result};

#[command]
pub(crate) async fn enqueue_download<R: Runtime>(
    app: AppHandle<R>,
    payload: DownloadRequest,
) -> Result<DownloadResponse> {
    app.media_download().enqueue_download(payload)
}
