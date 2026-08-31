use serde::de::DeserializeOwned;
use tauri::{plugin::PluginApi, AppHandle, Runtime};

use crate::models::{SecretKeyRequest, SecretResponse, SetSecretRequest};
use crate::{Error, Result};

pub struct SecureCredentials<R: Runtime>(AppHandle<R>);

pub fn init<R: Runtime, C: DeserializeOwned>(
    app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> Result<SecureCredentials<R>> {
    Ok(SecureCredentials(app.clone()))
}

impl<R: Runtime> SecureCredentials<R> {
    pub fn get_secret(&self, _payload: SecretKeyRequest) -> Result<SecretResponse> {
        Err(Error::UnsupportedPlatform)
    }

    pub fn remove_secret(&self, _payload: SecretKeyRequest) -> Result<()> {
        Err(Error::UnsupportedPlatform)
    }

    pub fn set_secret(&self, _payload: SetSecretRequest) -> Result<()> {
        Err(Error::UnsupportedPlatform)
    }
}
