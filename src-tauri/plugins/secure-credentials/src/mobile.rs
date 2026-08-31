use serde::de::DeserializeOwned;
use tauri::{
    plugin::{PluginApi, PluginHandle},
    AppHandle, Runtime,
};

use crate::models::{SecretKeyRequest, SecretResponse, SetSecretRequest};

pub struct SecureCredentials<R: Runtime>(PluginHandle<R>);

pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> crate::Result<SecureCredentials<R>> {
    #[cfg(target_os = "android")]
    let handle = api.register_android_plugin(
        "app.comfymobile.securecredentials",
        "SecureCredentialsPlugin",
    )?;
    Ok(SecureCredentials(handle))
}

impl<R: Runtime> SecureCredentials<R> {
    pub fn get_secret(&self, payload: SecretKeyRequest) -> crate::Result<SecretResponse> {
        self.0
            .run_mobile_plugin("getSecret", payload)
            .map_err(Into::into)
    }

    pub fn remove_secret(&self, payload: SecretKeyRequest) -> crate::Result<()> {
        self.0
            .run_mobile_plugin("removeSecret", payload)
            .map_err(Into::into)
    }

    pub fn set_secret(&self, payload: SetSecretRequest) -> crate::Result<()> {
        self.0
            .run_mobile_plugin("setSecret", payload)
            .map_err(Into::into)
    }
}
