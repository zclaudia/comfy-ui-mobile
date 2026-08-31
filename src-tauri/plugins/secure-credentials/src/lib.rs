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
use desktop::SecureCredentials;
#[cfg(mobile)]
use mobile::SecureCredentials;

pub trait SecureCredentialsExt<R: Runtime> {
    fn secure_credentials(&self) -> &SecureCredentials<R>;
}

impl<R: Runtime, T: Manager<R>> SecureCredentialsExt<R> for T {
    fn secure_credentials(&self) -> &SecureCredentials<R> {
        self.state::<SecureCredentials<R>>().inner()
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("secure-credentials")
        .invoke_handler(tauri::generate_handler![
            commands::get_secret,
            commands::remove_secret,
            commands::set_secret,
        ])
        .setup(|app, api| {
            #[cfg(mobile)]
            let secure_credentials = mobile::init(app, api)?;
            #[cfg(desktop)]
            let secure_credentials = desktop::init(app, api)?;
            app.manage(secure_credentials);
            Ok(())
        })
        .build()
}
