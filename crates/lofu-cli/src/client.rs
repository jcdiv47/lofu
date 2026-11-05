use std::time::Duration;

use serde_json::Value;
use ureq::Agent;

#[derive(Debug)]
pub enum Error {
    /// Non-2xx response from the server.
    Api {
        status: u16,
        message: String,
        body: Value,
    },
    /// Could not reach the server.
    Network(String),
    Usage(String),
    Other(String),
}

impl Error {
    pub fn exit_code(&self) -> u8 {
        match self {
            Error::Api { status: 404, .. } => 3,
            Error::Api {
                status: 401 | 403, ..
            } => 4,
            Error::Api {
                status: 400 | 409 | 422,
                ..
            } => 6,
            Error::Api { .. } | Error::Other(_) => 1,
            Error::Network(_) => 5,
            Error::Usage(_) => 2,
        }
    }

    pub fn message(&self) -> String {
        match self {
            Error::Api {
                status, message, ..
            } => format!("{message} (HTTP {status})"),
            Error::Network(m) => format!("cannot reach server: {m}"),
            Error::Usage(m) | Error::Other(m) => m.clone(),
        }
    }
}

/// Upper bound for content downloads (large articles as HTML).
const MAX_BODY: u64 = 256 * 1024 * 1024;

pub struct Client {
    agent: Agent,
    base: String,
    auth: String,
}

impl Client {
    pub fn new(base: &str, token: &str) -> Self {
        let agent: Agent = Agent::config_builder()
            .http_status_as_error(false)
            .timeout_connect(Some(Duration::from_secs(5)))
            .timeout_global(Some(Duration::from_secs(60)))
            .user_agent(concat!("lofu-cli/", env!("CARGO_PKG_VERSION")))
            .build()
            .into();
        Self {
            agent,
            base: base.trim_end_matches('/').to_owned(),
            auth: format!("Bearer {token}"),
        }
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.base, path)
    }

    fn finish(
        &self,
        res: Result<ureq::http::Response<ureq::Body>, ureq::Error>,
    ) -> Result<String, Error> {
        let mut res = res.map_err(|e| Error::Network(e.to_string()))?;
        let status = res.status().as_u16();
        let text = res
            .body_mut()
            .with_config()
            .limit(MAX_BODY)
            .read_to_string()
            .map_err(|e| Error::Network(e.to_string()))?;
        if (200..300).contains(&status) {
            return Ok(text);
        }
        let body: Value = serde_json::from_str(&text).unwrap_or(Value::String(text));
        let message = body["error"]
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| "request failed".into());
        Err(Error::Api {
            status,
            message,
            body,
        })
    }

    fn parse(text: String) -> Result<Value, Error> {
        if text.is_empty() {
            return Ok(Value::Null);
        }
        serde_json::from_str(&text)
            .map_err(|e| Error::Other(format!("invalid JSON from server: {e}")))
    }

    pub fn get_text(&self, path: &str, query: &[(&str, String)]) -> Result<String, Error> {
        let mut req = self
            .agent
            .get(self.url(path))
            .header("authorization", &self.auth);
        for (k, v) in query {
            req = req.query(*k, v);
        }
        self.finish(req.call())
    }

    pub fn get(&self, path: &str, query: &[(&str, String)]) -> Result<Value, Error> {
        Self::parse(self.get_text(path, query)?)
    }

    pub fn post(&self, path: &str, body: &Value) -> Result<Value, Error> {
        let req = self
            .agent
            .post(self.url(path))
            .header("authorization", &self.auth);
        Self::parse(self.finish(req.send_json(body))?)
    }

    /// POSTs a raw body (e.g. a CSV file) and parses the JSON response.
    pub fn post_raw(&self, path: &str, content_type: &str, body: &[u8]) -> Result<Value, Error> {
        let req = self
            .agent
            .post(self.url(path))
            .header("authorization", &self.auth)
            .header("content-type", content_type);
        Self::parse(self.finish(req.send(body))?)
    }

    pub fn patch(&self, path: &str, body: &Value) -> Result<Value, Error> {
        let req = self
            .agent
            .patch(self.url(path))
            .header("authorization", &self.auth);
        Self::parse(self.finish(req.send_json(body))?)
    }

    pub fn delete(&self, path: &str) -> Result<(), Error> {
        let req = self
            .agent
            .delete(self.url(path))
            .header("authorization", &self.auth);
        self.finish(req.call()).map(|_| ())
    }
}
