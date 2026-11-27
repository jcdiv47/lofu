//! Room the app's `Storage` (5 MB in all) doesn't have: the library's
//! snapshot and the articles kept for reading offline, as files in the
//! app's own data directory; and the API token in the Keychain on iOS.

use nsh_core::prelude::*;

/// Text files in the app's data directory (`Application Support` on Apple
/// platforms, `$XDG_DATA_HOME` on Linux). The web has none: `available()`
/// is false there and the app keeps to `Storage`.
#[module]
pub struct Files;

#[module]
impl Files {
    /// Whether files can be kept here (not on the web).
    pub fn available() -> bool {
        imp::dir().is_some()
    }

    /// The text of the file `name`, or null when there is none.
    pub async fn read(name: String) -> Option<String> {
        imp::run(move || imp::read(&name)).await.flatten()
    }

    /// Writes `text` to the file `name` (whole, through a temporary file, so
    /// a crash never leaves half of it). Resolves with whether it was written.
    pub async fn write(name: String, text: String) -> bool {
        imp::run(move || imp::write(&name, text.as_bytes()))
            .await
            .unwrap_or(false)
    }

    /// Writes `bytes` to the file `name`, as `write` does. Resolves with
    /// whether it was written.
    pub async fn write_bytes(name: String, bytes: Vec<u8>) -> bool {
        imp::run(move || imp::write(&name, &bytes))
            .await
            .unwrap_or(false)
    }

    /// The absolute path of the file `name` (whether or not it exists), for
    /// showing a kept picture: an image's source may be a path, which the
    /// loaders on macOS and iOS read as it is (iOS doesn't decode a `file:`
    /// URL's escapes, and `Application Support` has a space). Null where
    /// there are no files.
    pub fn path(name: String) -> Option<String> {
        imp::path(&name)?.to_str().map(str::to_owned)
    }

    /// Removes the file `name`. Resolves with whether it is gone.
    pub async fn remove(name: String) -> bool {
        imp::run(move || imp::remove(&name)).await.unwrap_or(false)
    }

    /// The names of the files whose names start with `prefix`.
    pub async fn list(prefix: String) -> Vec<String> {
        imp::run(move || imp::list(&prefix))
            .await
            .unwrap_or_default()
    }

    /// The bytes the files whose names start with `prefix` take, together.
    pub async fn size(prefix: String) -> f64 {
        imp::run(move || imp::size(&prefix)).await.unwrap_or(0) as f64
    }
}

#[cfg(target_arch = "wasm32")]
mod imp {
    use std::path::PathBuf;

    pub fn dir() -> Option<PathBuf> {
        None
    }

    pub async fn run<R>(_f: impl FnOnce() -> R) -> Option<R> {
        None
    }

    pub fn read(_name: &str) -> Option<String> {
        None
    }
    pub fn write(_name: &str, _data: &[u8]) -> bool {
        false
    }
    pub fn path(_name: &str) -> Option<PathBuf> {
        None
    }
    pub fn remove(_name: &str) -> bool {
        false
    }
    pub fn list(_prefix: &str) -> Vec<String> {
        Vec::new()
    }
    pub fn size(_prefix: &str) -> u64 {
        0
    }
}

#[cfg(not(target_arch = "wasm32"))]
mod imp {
    use std::path::PathBuf;
    use std::{env, fs};

    const APP: &str = "app.lofu.reader";

    /// Off the engine's thread: file I/O can take a while on a busy disk.
    pub async fn run<R: Send + 'static>(f: impl FnOnce() -> R + Send + 'static) -> Option<R> {
        nsh_core::prelude::blocking(f).await.ok()
    }

    /// `nsh test`'s headless runner (`nsh-app-<crate>-test`): each test gets
    /// storage of its own, which files on the disk would leak between them.
    fn under_test() -> bool {
        env::current_exe()
            .ok()
            .and_then(|p| p.file_stem()?.to_str().map(|n| n.ends_with("-test")))
            .unwrap_or(false)
    }

    pub fn dir() -> Option<PathBuf> {
        if under_test() {
            return None;
        }
        let home = env::var_os("HOME").map(PathBuf::from);
        let base = if cfg!(any(target_os = "ios", target_os = "macos")) {
            // iOS: HOME is the app's container. macOS: the user's home.
            home?.join("Library/Application Support")
        } else if let Some(xdg) = env::var_os("XDG_DATA_HOME").filter(|v| !v.is_empty()) {
            PathBuf::from(xdg)
        } else {
            home?.join(".local/share")
        };
        Some(base.join(APP))
    }

    /// Names are the app's own keys: letters, digits, `.`, `-` and `_` only,
    /// so a name never leaves the directory.
    pub fn path(name: &str) -> Option<PathBuf> {
        let ok = !name.is_empty()
            && !name.starts_with('.')
            && name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'));
        ok.then(|| dir().map(|d| d.join(name))).flatten()
    }

    pub fn read(name: &str) -> Option<String> {
        fs::read_to_string(path(name)?).ok()
    }

    pub fn write(name: &str, data: impl AsRef<[u8]>) -> bool {
        let (Some(dir), Some(to)) = (dir(), path(name)) else {
            return false;
        };
        let tmp = dir.join(format!(".{name}.tmp"));
        fs::create_dir_all(&dir).is_ok()
            && fs::write(&tmp, data).is_ok()
            && fs::rename(&tmp, &to).is_ok()
    }

    pub fn remove(name: &str) -> bool {
        let Some(p) = path(name) else {
            return false;
        };
        fs::remove_file(&p).is_ok() || !p.exists()
    }

    pub fn list(prefix: &str) -> Vec<String> {
        let Some(dir) = dir() else {
            return Vec::new();
        };
        let Ok(entries) = fs::read_dir(dir) else {
            return Vec::new();
        };
        entries
            .filter_map(|e| e.ok()?.file_name().into_string().ok())
            .filter(|n| n.starts_with(prefix) && !n.starts_with('.'))
            .collect()
    }

    pub fn size(prefix: &str) -> u64 {
        let Some(dir) = dir() else {
            return 0;
        };
        list(prefix)
            .iter()
            .filter_map(|n| fs::metadata(dir.join(n)).ok())
            .map(|m| m.len())
            .sum()
    }
}

/// Secrets kept by the system: the Keychain on iOS, where the app's
/// `Storage` is a plain file in its container. Elsewhere `available()` is
/// false and the app keeps them in `Storage` (macOS asks for the login
/// keychain's password whenever an unsigned build changes, which every
/// development build does).
#[module]
pub struct Secrets;

#[module]
impl Secrets {
    /// Whether secrets go to the system's keychain here (iOS).
    pub fn available() -> bool {
        cfg!(target_os = "ios")
    }

    /// The secret `key`, or null.
    pub fn get(key: String) -> Option<String> {
        keychain::get(&key)
    }

    /// Keeps `value` as the secret `key` (an empty value removes it).
    /// Returns whether the keychain took it.
    pub fn set(key: String, value: String) -> bool {
        keychain::set(&key, &value)
    }
}

#[cfg(not(target_os = "ios"))]
mod keychain {
    pub fn get(_key: &str) -> Option<String> {
        None
    }
    pub fn set(_key: &str, _value: &str) -> bool {
        false
    }
}

#[cfg(target_os = "ios")]
mod keychain {
    use security_framework::passwords::{
        delete_generic_password, get_generic_password, set_generic_password,
    };

    /// Not the share extension's item (`login` in `lib.rs`), which lives in
    /// a group only builds with the extension have.
    const SERVICE: &str = "app.lofu.reader.secrets";

    pub fn get(key: &str) -> Option<String> {
        String::from_utf8(get_generic_password(SERVICE, key).ok()?).ok()
    }

    pub fn set(key: &str, value: &str) -> bool {
        if value.is_empty() {
            return delete_generic_password(SERVICE, key).is_ok() || get(key).is_none();
        }
        set_generic_password(SERVICE, key, value.as_bytes()).is_ok()
    }
}
