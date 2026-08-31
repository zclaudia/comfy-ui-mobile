use tauri::{command, AppHandle, Runtime};

use crate::models::{SecretKeyRequest, SecretResponse, SetSecretRequest};
use crate::{Result, SecureCredentialsExt};

#[command]
pub(crate) async fn get_secret<R: Runtime>(
    app: AppHandle<R>,
    payload: SecretKeyRequest,
) -> Result<SecretResponse> {
    app.secure_credentials().get_secret(payload)
}

#[command]
pub(crate) async fn remove_secret<R: Runtime>(
    app: AppHandle<R>,
    payload: SecretKeyRequest,
) -> Result<()> {
    app.secure_credentials().remove_secret(payload)
}

#[command]
pub(crate) async fn set_secret<R: Runtime>(
    app: AppHandle<R>,
    payload: SetSecretRequest,
) -> Result<()> {
    app.secure_credentials().set_secret(payload)
}
