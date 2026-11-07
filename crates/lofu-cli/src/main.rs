//! `lofu` — command-line client for the lofu bookmark server.
//!
//! Agent contract:
//! - stdout is JSON whenever it is not a terminal (or with `--json`); the
//!   shapes are the server's API objects (see `/openapi.json`).
//! - errors go to stderr (JSON in JSON mode) with stable exit codes:
//!   1 other, 2 usage, 3 not found, 4 unauthorized, 5 server unreachable,
//!   6 invalid request.
//! - `add` is idempotent: saving a known URL returns the existing bookmark.

mod client;
mod config;
mod output;

use std::io::{IsTerminal, Read};
use std::process::ExitCode;

use clap::{Args, Parser, Subcommand, ValueEnum};
use serde_json::{Map, Value, json};

use client::{Client, Error};
use output::Out;

#[derive(Parser)]
#[command(
    name = "lofu",
    version,
    about = "Bookmarks & read-later from the command line"
)]
struct Cli {
    /// Server URL (overrides LOFU_URL and the config file)
    #[arg(long, global = true, env = "LOFU_URL", hide_env_values = true)]
    server: Option<String>,
    /// API token (overrides LOFU_TOKEN and the config file)
    #[arg(long, global = true, env = "LOFU_TOKEN", hide_env_values = true)]
    token: Option<String>,
    /// Force JSON output (the default when stdout is not a terminal)
    #[arg(long, global = true)]
    json: bool,
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Save server URL and token to the config file
    Login {
        #[arg(long)]
        url: String,
        #[arg(long)]
        token: String,
    },
    /// Check connectivity and search status
    Health,
    /// Save a URL (idempotent; re-saving merges tags)
    Add(AddArgs),
    /// Show a bookmark, optionally with its extracted content
    Get {
        id: String,
        /// Include the extracted content in this format
        #[arg(long, value_enum, default_value_t = Format::None)]
        content: Format,
    },
    /// Print only the extracted content (markdown by default), for piping
    Content {
        id: String,
        #[arg(long, value_enum, default_value_t = RawFormat::Markdown)]
        format: RawFormat,
    },
    /// Update fields of a bookmark
    Update(UpdateArgs),
    /// Delete bookmarks for good (to move them to the Trash: `update --trashed true`)
    Rm {
        #[arg(required = true)]
        ids: Vec<String>,
    },
    /// List bookmarks, newest first
    Ls(ListArgs),
    /// Full-text search over titles, notes, highlights and page content
    Search(SearchArgs),
    /// List tags with counts
    Tags,
    /// Manage collections
    #[command(subcommand)]
    Collections(CollectionCmd),
    /// List highlights of a bookmark
    Highlights { id: String },
    /// Re-fetch and re-extract a page
    Refetch { id: String },
    /// Import bookmarks from another service
    #[command(subcommand)]
    Import(ImportCmd),
}

#[derive(Subcommand)]
enum ImportCmd {
    /// Import a Raindrop.io CSV export ("-" reads stdin). Safe to re-run.
    ///
    /// e.g. `raindrop bookmark export --format csv | lofu import raindrop -`
    Raindrop { file: String },
}

#[derive(Args)]
struct AddArgs {
    url: String,
    /// Tag (repeatable or comma-separated)
    #[arg(short, long = "tag", value_delimiter = ',')]
    tags: Vec<String>,
    #[arg(long)]
    title: Option<String>,
    #[arg(long)]
    note: Option<String>,
    /// Collection id
    #[arg(short, long)]
    collection: Option<String>,
    #[arg(long)]
    favorite: bool,
    /// Save it straight into the Trash
    #[arg(long, alias = "archived")]
    trashed: bool,
    /// Use this HTML instead of fetching the page ("-" reads stdin)
    #[arg(long, value_name = "PATH")]
    html: Option<String>,
}

#[derive(Args)]
struct UpdateArgs {
    id: String,
    #[arg(long)]
    title: Option<String>,
    /// New note ("" clears it)
    #[arg(long)]
    note: Option<String>,
    /// Replace all tags (comma-separated; "" clears)
    #[arg(long, value_delimiter = ',', num_args = 0..)]
    tags: Option<Vec<String>>,
    /// Add a tag (repeatable)
    #[arg(long = "add-tag", value_delimiter = ',')]
    add_tags: Vec<String>,
    /// Remove a tag (repeatable)
    #[arg(long = "remove-tag", value_delimiter = ',')]
    remove_tags: Vec<String>,
    /// Collection id, or "none" for unsorted
    #[arg(short, long)]
    collection: Option<String>,
    #[arg(long)]
    favorite: Option<bool>,
    /// Move to the Trash (true) or restore from it (false)
    #[arg(long, alias = "archived", value_name = "BOOL")]
    trashed: Option<bool>,
    /// Reading progress 0..1
    #[arg(long)]
    progress: Option<f64>,
}

#[derive(Args)]
struct Filters {
    /// Collection id ("unsorted" for none)
    #[arg(short, long)]
    collection: Option<String>,
    /// Require tag (repeatable or comma-separated; all must match)
    #[arg(short, long = "tag", value_delimiter = ',')]
    tags: Vec<String>,
    /// Only bookmarks in the Trash (true), or none of them (false)
    #[arg(long, alias = "archived", value_name = "BOOL")]
    trashed: Option<bool>,
    #[arg(long)]
    favorite: Option<bool>,
    #[arg(long = "type", value_enum)]
    kind: Option<Kind>,
}

#[derive(Args)]
struct ListArgs {
    #[command(flatten)]
    filters: Filters,
    #[arg(short = 'n', long, default_value_t = 50)]
    limit: u32,
    /// Cursor from a previous page
    #[arg(long)]
    cursor: Option<String>,
    /// Follow cursors and return every match
    #[arg(long)]
    all: bool,
}

#[derive(Args)]
struct SearchArgs {
    /// Query words
    #[arg(required = true)]
    query: Vec<String>,
    #[command(flatten)]
    filters: Filters,
    #[arg(long)]
    domain: Option<String>,
    #[arg(long, value_enum, default_value_t = Sort::Relevance)]
    sort: Sort,
    #[arg(short = 'n', long, default_value_t = 20)]
    limit: u32,
    #[arg(long, default_value_t = 0)]
    offset: u32,
}

#[derive(Subcommand)]
enum CollectionCmd {
    /// List collections
    Ls,
    /// Create a collection
    Add {
        name: String,
        #[arg(long)]
        parent: Option<String>,
    },
    /// Delete a collection (its bookmarks become unsorted)
    Rm { id: String },
}

#[derive(Clone, Copy, ValueEnum)]
enum Format {
    None,
    Markdown,
    Html,
    Text,
}

#[derive(Clone, Copy, ValueEnum)]
enum RawFormat {
    Markdown,
    Html,
    Text,
}

#[derive(Clone, Copy, ValueEnum)]
enum Kind {
    Article,
    Video,
    Image,
    Audio,
    Document,
    Link,
}

#[derive(Clone, Copy, ValueEnum)]
enum Sort {
    Relevance,
    Newest,
    Oldest,
}

fn name<T: ValueEnum>(v: T) -> String {
    v.to_possible_value()
        .expect("no skipped variants")
        .get_name()
        .to_owned()
}

fn filter_query(f: &Filters) -> Vec<(&'static str, String)> {
    let mut q = Vec::new();
    if let Some(c) = &f.collection {
        q.push(("collectionId", c.clone()));
    }
    if !f.tags.is_empty() {
        q.push(("tags", f.tags.join(",")));
    }
    // The API calls the Trash `archived`.
    if let Some(t) = f.trashed {
        q.push(("archived", t.to_string()));
    }
    if let Some(v) = f.favorite {
        q.push(("favorite", v.to_string()));
    }
    if let Some(k) = f.kind {
        q.push(("type", name(k)));
    }
    q
}

/// Reads a file path, or stdin for "-".
fn read_input(path: &str) -> Result<Vec<u8>, Error> {
    if path == "-" {
        let mut buf = Vec::new();
        std::io::stdin()
            .read_to_end(&mut buf)
            .map_err(|e| Error::Other(format!("stdin: {e}")))?;
        Ok(buf)
    } else {
        std::fs::read(path).map_err(|e| Error::Other(format!("{path}: {e}")))
    }
}

fn run(cli: Cli, out: &Out) -> Result<(), Error> {
    if let Cmd::Login { url, token } = &cli.cmd {
        let path = config::save(url, token).map_err(|e| Error::Other(e.to_string()))?;
        Client::new(url, token).get("/health", &[])?;
        out.message(&format!("saved to {}", path.display()));
        return Ok(());
    }
    let cfg = config::resolve(cli.server, cli.token).map_err(Error::Usage)?;
    let api = Client::new(&cfg.url, &cfg.token);

    match cli.cmd {
        Cmd::Login { .. } => unreachable!(),
        Cmd::Health => out.value(&api.get("/health", &[])?),
        Cmd::Add(a) => {
            let mut body = Map::new();
            body.insert("url".into(), json!(a.url));
            if !a.tags.is_empty() {
                body.insert("tags".into(), json!(a.tags));
            }
            if let Some(t) = a.title {
                body.insert("title".into(), json!(t));
            }
            if let Some(n) = a.note {
                body.insert("note".into(), json!(n));
            }
            if let Some(c) = a.collection {
                body.insert("collectionId".into(), json!(c));
            }
            if a.favorite {
                body.insert("favorite".into(), json!(true));
            }
            if a.trashed {
                body.insert("archived".into(), json!(true));
            }
            if let Some(path) = a.html {
                let html = if path == "-" {
                    let mut s = String::new();
                    std::io::stdin()
                        .read_to_string(&mut s)
                        .map_err(|e| Error::Other(e.to_string()))?;
                    s
                } else {
                    std::fs::read_to_string(&path)
                        .map_err(|e| Error::Other(format!("{path}: {e}")))?
                };
                body.insert("html".into(), json!(html));
            }
            out.bookmark(&api.post("/v1/bookmarks", &Value::Object(body))?);
        }
        Cmd::Get { id, content } => {
            let b = api.get(
                &format!("/v1/bookmarks/{id}"),
                &[("content", name(content))],
            )?;
            out.bookmark_detail(&b);
        }
        Cmd::Content { id, format } => {
            let text = api.get_text(
                &format!("/v1/bookmarks/{id}/content"),
                &[("format", name(format))],
            )?;
            out.raw(&text);
        }
        Cmd::Update(u) => {
            let mut body = Map::new();
            if let Some(t) = u.title {
                body.insert("title".into(), json!(t));
            }
            if let Some(n) = u.note {
                body.insert(
                    "note".into(),
                    if n.is_empty() { Value::Null } else { json!(n) },
                );
            }
            if let Some(c) = u.collection {
                body.insert(
                    "collectionId".into(),
                    if c == "none" { Value::Null } else { json!(c) },
                );
            }
            if let Some(f) = u.favorite {
                body.insert("favorite".into(), json!(f));
            }
            if let Some(t) = u.trashed {
                body.insert("archived".into(), json!(t));
            }
            if let Some(p) = u.progress {
                body.insert("readProgress".into(), json!(p));
            }
            if u.tags.is_some() || !u.add_tags.is_empty() || !u.remove_tags.is_empty() {
                let mut tags: Vec<String> = match u.tags {
                    Some(t) => t.into_iter().filter(|t| !t.is_empty()).collect(),
                    None => {
                        let cur = api.get(&format!("/v1/bookmarks/{}", u.id), &[])?;
                        serde_json::from_value(cur["tags"].clone()).unwrap_or_default()
                    }
                };
                let norm = |t: &String| t.trim().to_lowercase();
                tags.extend(u.add_tags.iter().map(norm));
                let remove: Vec<String> = u.remove_tags.iter().map(norm).collect();
                tags.retain(|t| !remove.contains(&t.to_lowercase()));
                body.insert("tags".into(), json!(tags));
            }
            if body.is_empty() {
                return Err(Error::Usage("nothing to update".into()));
            }
            out.bookmark(&api.patch(&format!("/v1/bookmarks/{}", u.id), &Value::Object(body))?);
        }
        Cmd::Rm { ids } => {
            for id in &ids {
                api.delete(&format!("/v1/bookmarks/{id}"))?;
            }
            out.value_or_message(
                &json!({ "deleted": ids }),
                &format!("deleted {}", ids.len()),
            );
        }
        Cmd::Ls(l) => {
            let mut q = filter_query(&l.filters);
            q.push(("limit", l.limit.to_string()));
            let mut cursor = l.cursor;
            let mut items: Vec<Value> = Vec::new();
            let next = loop {
                let mut page_q = q.clone();
                if let Some(c) = &cursor {
                    page_q.push(("cursor", c.clone()));
                }
                let page = api.get("/v1/bookmarks", &page_q)?;
                if let Some(arr) = page["items"].as_array() {
                    items.extend(arr.iter().cloned());
                }
                cursor = page["nextCursor"].as_str().map(str::to_owned);
                if !l.all || cursor.is_none() {
                    break cursor;
                }
            };
            out.bookmark_list(&items, next.as_deref());
        }
        Cmd::Search(s) => {
            let mut q = filter_query(&s.filters);
            q.push(("q", s.query.join(" ")));
            q.push(("sort", name(s.sort)));
            q.push(("limit", s.limit.to_string()));
            q.push(("offset", s.offset.to_string()));
            if let Some(d) = s.domain {
                q.push(("domain", d));
            }
            out.search(&api.get("/v1/search", &q)?);
        }
        Cmd::Tags => out.tags(&api.get("/v1/tags", &[])?),
        Cmd::Collections(c) => match c {
            CollectionCmd::Ls => out.collections(&api.get("/v1/collections", &[])?),
            CollectionCmd::Add { name, parent } => {
                let v = api.post(
                    "/v1/collections",
                    &json!({ "name": name, "parentId": parent }),
                )?;
                out.value_or_message(&v, &format!("{}  {}", v["id"].as_str().unwrap_or(""), name));
            }
            CollectionCmd::Rm { id } => {
                api.delete(&format!("/v1/collections/{id}"))?;
                out.value_or_message(&json!({ "deleted": [id] }), "deleted");
            }
        },
        Cmd::Highlights { id } => {
            out.highlights(&api.get(&format!("/v1/bookmarks/{id}/highlights"), &[])?)
        }
        Cmd::Import(ImportCmd::Raindrop { file }) => {
            let data = read_input(&file)?;
            out.import_report(&api.post_raw("/v1/import/raindrop", "text/csv", &data)?);
        }
        Cmd::Refetch { id } => {
            out.bookmark(&api.post(&format!("/v1/bookmarks/{id}/refetch"), &json!({}))?)
        }
    }
    Ok(())
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    let out = Out::new(cli.json || !std::io::stdout().is_terminal());
    match run(cli, &out) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            out.error(&e);
            ExitCode::from(e.exit_code())
        }
    }
}
