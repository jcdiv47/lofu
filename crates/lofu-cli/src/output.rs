use std::io::{IsTerminal, Write};

use serde_json::{Value, json};

use crate::client::Error;

/// Renders results as compact JSON (agents, pipes) or short human text.
pub struct Out {
    json: bool,
    color: bool,
}

fn s(v: &Value) -> &str {
    v.as_str().unwrap_or("")
}

impl Out {
    pub fn new(json: bool) -> Self {
        let color =
            !json && std::io::stdout().is_terminal() && std::env::var_os("NO_COLOR").is_none();
        Self { json, color }
    }

    fn print(&self, text: &str) {
        let mut stdout = std::io::stdout().lock();
        // Ignore EPIPE (e.g. `lofu ls | head`).
        let _ = writeln!(stdout, "{text}");
    }

    fn dim(&self, t: &str) -> String {
        if self.color {
            format!("\x1b[2m{t}\x1b[0m")
        } else {
            t.to_owned()
        }
    }

    fn bold(&self, t: &str) -> String {
        if self.color {
            format!("\x1b[1m{t}\x1b[0m")
        } else {
            t.to_owned()
        }
    }

    pub fn value(&self, v: &Value) {
        if self.json {
            self.print(&v.to_string());
        } else {
            self.print(&serde_json::to_string_pretty(v).unwrap_or_default());
        }
    }

    pub fn raw(&self, text: &str) {
        let mut stdout = std::io::stdout().lock();
        let _ = stdout.write_all(text.as_bytes());
        if !text.ends_with('\n') {
            let _ = stdout.write_all(b"\n");
        }
    }

    pub fn message(&self, msg: &str) {
        if self.json {
            self.print(&json!({ "ok": true, "message": msg }).to_string());
        } else {
            self.print(msg);
        }
    }

    pub fn value_or_message(&self, v: &Value, msg: &str) {
        if self.json {
            self.value(v)
        } else {
            self.print(msg)
        }
    }

    fn bookmark_lines(&self, b: &Value) -> String {
        let title = if s(&b["title"]).is_empty() {
            s(&b["url"])
        } else {
            s(&b["title"])
        };
        let mut meta = vec![s(&b["domain"]).to_owned()];
        if let Some(tags) = b["tags"].as_array().filter(|t| !t.is_empty()) {
            meta.push(
                tags.iter()
                    .map(|t| format!("#{}", s(t)))
                    .collect::<Vec<_>>()
                    .join(" "),
            );
        }
        if b["favorite"].as_bool() == Some(true) {
            meta.push("★".into());
        }
        if b["archived"].as_bool() == Some(true) {
            meta.push("archived".into());
        }
        match s(&b["contentStatus"]) {
            "ok" | "" => {}
            status => meta.push(status.to_owned()),
        }
        format!(
            "{}  {}\n    {}",
            self.dim(s(&b["id"])),
            self.bold(title),
            self.dim(&meta.join(" · "))
        )
    }

    pub fn bookmark(&self, b: &Value) {
        if self.json {
            self.value(b)
        } else {
            self.print(&self.bookmark_lines(b))
        }
    }

    pub fn bookmark_detail(&self, b: &Value) {
        if self.json {
            return self.value(b);
        }
        self.print(&self.bookmark_lines(b));
        self.print(&format!("    {}", s(&b["url"])));
        for (label, key) in [
            ("author", "author"),
            ("published", "publishedAt"),
            ("words", "wordCount"),
        ] {
            match &b[key] {
                Value::Null => {}
                v => self.print(&format!(
                    "    {label}: {}",
                    v.as_str().map_or_else(|| v.to_string(), str::to_owned)
                )),
            }
        }
        if let Some(note) = b["note"].as_str() {
            self.print(&format!("    note: {note}"));
        }
        if let Some(err) = b["contentError"].as_str() {
            self.print(&format!("    error: {err}"));
        }
        if let Some(content) = b["content"].as_str() {
            self.print("");
            self.print(content);
        }
    }

    pub fn bookmark_list(&self, items: &[Value], next: Option<&str>) {
        if self.json {
            return self.value(&json!({ "items": items, "nextCursor": next }));
        }
        for b in items {
            self.print(&self.bookmark_lines(b));
        }
        if let Some(c) = next {
            self.print(&self.dim(&format!("more: --cursor {c}")));
        }
    }

    pub fn search(&self, res: &Value) {
        if self.json {
            return self.value(res);
        }
        let empty = vec![];
        let hits = res["hits"].as_array().unwrap_or(&empty);
        for h in hits {
            self.print(&self.bookmark_lines(&h["bookmark"]));
            if let Some(snippet) = h["snippet"].as_str() {
                let (on, off) = if self.color {
                    ("\x1b[1;33m", "\x1b[0m")
                } else {
                    ("**", "**")
                };
                let text = snippet
                    .replace("<mark>", on)
                    .replace("</mark>", off)
                    .replace('\n', " ");
                self.print(&format!("    {text}"));
            }
        }
        self.print(&self.dim(&format!(
            "{} of ~{} results in {} ms",
            hits.len(),
            res["estimatedTotal"],
            res["processingTimeMs"]
        )));
    }

    pub fn tags(&self, tags: &Value) {
        if self.json {
            return self.value(tags);
        }
        for t in tags.as_array().into_iter().flatten() {
            self.print(&format!("{:>6}  {}", t["count"], s(&t["name"])));
        }
    }

    pub fn collections(&self, cols: &Value) {
        if self.json {
            return self.value(cols);
        }
        let all = cols.as_array().cloned().unwrap_or_default();
        fn walk(out: &Out, all: &[Value], parent: &Value, depth: usize) {
            for c in all.iter().filter(|c| &c["parentId"] == parent) {
                out.print(&format!(
                    "{}{}  {}",
                    "  ".repeat(depth),
                    out.dim(s(&c["id"])),
                    s(&c["name"])
                ));
                walk(out, all, &c["id"], depth + 1);
            }
        }
        walk(self, &all, &Value::Null, 0);
    }

    pub fn highlights(&self, hs: &Value) {
        if self.json {
            return self.value(hs);
        }
        for h in hs.as_array().into_iter().flatten() {
            self.print(&format!("{}  “{}”", self.dim(s(&h["id"])), s(&h["quote"])));
            if let Some(n) = h["note"].as_str() {
                self.print(&format!("    {n}"));
            }
        }
    }

    pub fn error(&self, e: &Error) {
        let mut stderr = std::io::stderr().lock();
        if self.json {
            let mut v = json!({ "error": e.message(), "exitCode": e.exit_code() });
            if let Error::Api { status, body, .. } = e {
                v["status"] = json!(status);
                if let Some(d) = body.get("details") {
                    v["details"] = d.clone();
                }
            }
            let _ = writeln!(stderr, "{v}");
        } else {
            let _ = writeln!(stderr, "error: {}", e.message());
        }
    }
}
