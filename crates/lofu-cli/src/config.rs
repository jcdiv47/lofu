use std::path::PathBuf;

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Default)]
pub struct Config {
    pub url: String,
    pub token: String,
}

/// `$XDG_CONFIG_HOME/lofu/config.json`, falling back to `~/.config/lofu/config.json`
/// on every platform (including macOS) so agents find it in one place.
fn path() -> Option<PathBuf> {
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))?;
    Some(base.join("lofu").join("config.json"))
}

pub fn save(url: &str, token: &str) -> std::io::Result<PathBuf> {
    let p = path().ok_or_else(|| std::io::Error::other("cannot locate config dir (HOME unset)"))?;
    std::fs::create_dir_all(p.parent().expect("config path has a parent"))?;
    let cfg = Config {
        url: url.to_owned(),
        token: token.to_owned(),
    };
    let data = serde_json::to_vec_pretty(&cfg).map_err(std::io::Error::other)?;
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&p)?;
        f.write_all(&data)?;
    }
    #[cfg(not(unix))]
    std::fs::write(&p, data)?;
    Ok(p)
}

/// Flags/env (already merged by clap) take precedence over the config file.
pub fn resolve(url: Option<String>, token: Option<String>) -> Result<Config, String> {
    let file: Config = path()
        .and_then(|p| std::fs::read(p).ok())
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    let url = url.filter(|s| !s.is_empty()).unwrap_or(file.url);
    let token = token.filter(|s| !s.is_empty()).unwrap_or(file.token);
    if url.is_empty() {
        return Err(
            "no server configured: run `lofu login --url <SERVER> --token <TOKEN>` or set LOFU_URL"
                .into(),
        );
    }
    Ok(Config { url, token })
}
