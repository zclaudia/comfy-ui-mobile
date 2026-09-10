use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadRequest {
    pub url: String,
    pub filename: String,
    pub authorization: Option<String>,
    pub mime_type: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadResponse {
    pub download_id: i64,
    pub filename: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveJsonRequest {
    pub filename: String,
    pub contents: String,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct SaveJsonResponse {
    pub saved: bool,
}
