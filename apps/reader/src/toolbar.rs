//! The window's toolbar on macOS: a real `NSToolbar`, whose items AppKit
//! draws in Liquid Glass on macOS 26 (bordered symbols that it groups into
//! capsules, a prominent item filled with its tint, the system's search
//! field). nsh's hidden title bar already puts an empty toolbar on the
//! window for its height; this one takes its place, and nsh leaves a
//! toolbar it didn't install alone.
//!
//! The items sit in the title bar, outside nsh's root view, so clicks reach
//! them as they reach any AppKit control (inside the root, nsh 0.4 loses a
//! click on a hosted view: see `components/native.tsx`).
//!
//! TSX describes the items as JSON (`set`); clicks and search edits come
//! back one at a time through `next`, which the app keeps awaiting
//! (`lib/toolbar.ts`). Modules run on nsh's engine thread, AppKit on the
//! main one: `set` hands the items over with `exec_async`.

use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Mutex, OnceLock};

/// Where the toolbar sends its events, and where `next` takes them from.
type Events = (Mutex<Sender<String>>, Mutex<Receiver<String>>);

/// The events the toolbar sent and `next` hasn't handed to the app yet.
fn events() -> &'static Events {
    static EVENTS: OnceLock<Events> = OnceLock::new();
    EVENTS.get_or_init(|| {
        let (tx, rx) = channel();
        (Mutex::new(tx), Mutex::new(rx))
    })
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn emit(event: serde_json::Value) {
    let tx = events().0.lock().unwrap_or_else(|e| e.into_inner());
    let _ = tx.send(event.to_string());
}

/// The next click or search edit, as JSON: `{ type: "press", id, x, y }`
/// (the pointer, from the window's top left) or `{ type: "search", id, value }`;
/// "" after a second without one. The app asks again at once; the timeout
/// lets a JS context that's gone (a hot reload) stop waiting, instead of
/// holding the queue and taking the next event from the one that's live.
pub async fn next() -> String {
    nsh_core::prelude::blocking(|| {
        let rx = events().1.lock().unwrap_or_else(|e| e.into_inner());
        rx.recv_timeout(std::time::Duration::from_secs(1))
            .unwrap_or_default()
    })
    .await
    .unwrap_or_default()
}

#[cfg(not(target_os = "macos"))]
pub fn set(_items: String) {}

#[cfg(not(target_os = "macos"))]
pub fn search() {}

#[cfg(target_os = "macos")]
pub use mac::{search, set};

#[cfg(target_os = "macos")]
mod mac {
    use std::cell::RefCell;
    use std::collections::HashMap;

    use objc2::rc::{Allocated, Retained};
    use objc2::runtime::{AnyObject, NSObject, NSObjectProtocol};
    use objc2::{MainThreadMarker, MainThreadOnly, class, define_class, msg_send, sel};
    use objc2_foundation::{NSArray, NSPoint, NSRect, NSSize, NSString};
    use serde_json::Value;

    use super::emit;

    const FLEX: &str = "NSToolbarFlexibleSpaceItem";
    const GAP: &str = "NSToolbarSpaceItem";
    const PREFIX: &str = "lofu.";

    /// One item, as TSX describes it.
    #[derive(Clone, PartialEq)]
    struct Item {
        id: String,
        /// `button`, `search`, `space` (leading room, up to `x`), `flex`, `gap`.
        kind: String,
        symbol: Option<String>,
        label: String,
        tint: Option<[f64; 4]>,
        prominent: bool,
        disabled: bool,
        placeholder: String,
        value: String,
        width: f64,
        /// `space`: where the next item starts, from the window's left edge.
        x: f64,
    }

    impl Item {
        fn parse(v: &Value) -> Option<Item> {
            let s = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_owned);
            let kind = s("kind")?;
            Some(Item {
                id: s("id").unwrap_or_default(),
                symbol: s("symbol"),
                label: s("label").unwrap_or_default(),
                tint: crate::controls::parse_color(v.get("tint")),
                prominent: v.get("prominent").and_then(Value::as_bool).unwrap_or(false),
                disabled: v.get("disabled").and_then(Value::as_bool).unwrap_or(false),
                placeholder: s("placeholder").unwrap_or_default(),
                value: s("value").unwrap_or_default(),
                width: v.get("width").and_then(Value::as_f64).unwrap_or(240.0),
                x: v.get("x").and_then(Value::as_f64).unwrap_or(0.0),
                kind,
            })
        }

        /// Its identifier in the toolbar: the system's for spaces.
        fn identifier(&self) -> String {
            match self.kind.as_str() {
                "flex" => FLEX.into(),
                "gap" => GAP.into(),
                kind => format!("{PREFIX}{kind}.{}", self.id),
            }
        }
    }

    thread_local! {
        /// The items the toolbar shows, or is about to.
        static ITEMS: RefCell<Vec<Item>> = const { RefCell::new(Vec::new()) };
        /// The toolbar items made for them, by identifier.
        static MADE: RefCell<HashMap<String, Retained<AnyObject>>> = RefCell::new(HashMap::new());
        /// The toolbar and its delegate (which the toolbar holds weakly).
        static TOOLBAR: RefCell<Option<(Retained<AnyObject>, Retained<Delegate>)>> =
            const { RefCell::new(None) };
        /// Each `space` item's width constraint.
        static SPACES: RefCell<HashMap<String, Retained<AnyObject>>> = RefCell::new(HashMap::new());
    }

    define_class!(
        /// The toolbar's delegate, and the target of its items.
        #[unsafe(super(NSObject))]
        #[thread_kind = MainThreadOnly]
        #[name = "LofuToolbarDelegate"]
        struct Delegate;

        impl Delegate {
            #[unsafe(method_id(toolbar:itemForItemIdentifier:willBeInsertedIntoToolbar:))]
            fn item_for(
                &self,
                _toolbar: &AnyObject,
                identifier: &NSString,
                _inserted: bool,
            ) -> Option<Retained<AnyObject>> {
                let identifier = identifier.to_string();
                let item = ITEMS.with(|items| {
                    items.borrow().iter().find(|i| i.identifier() == identifier).cloned()
                });
                item.map(|item| {
                    // SAFETY: AppKit asks on the main thread.
                    let made = unsafe { make(&item, self) };
                    MADE.with(|m| m.borrow_mut().insert(identifier, made.clone()));
                    made
                })
            }

            #[unsafe(method_id(toolbarDefaultItemIdentifiers:))]
            fn defaults(&self, _toolbar: &AnyObject) -> Retained<NSArray<NSString>> {
                identifiers()
            }

            #[unsafe(method_id(toolbarAllowedItemIdentifiers:))]
            fn allowed(&self, _toolbar: &AnyObject) -> Retained<NSArray<NSString>> {
                identifiers()
            }

            #[unsafe(method(fire:))]
            fn fire(&self, sender: &AnyObject) {
                // SAFETY: an NSToolbarItem sent its action.
                let identifier: Retained<NSString> = unsafe { msg_send![sender, itemIdentifier] };
                let (x, y) = unsafe { pointer() };
                emit(serde_json::json!({
                    "type": "press",
                    "id": id_of(&identifier.to_string()),
                    "x": x,
                    "y": y,
                }));
            }

            #[unsafe(method(searched:))]
            fn searched(&self, sender: &AnyObject) {
                // SAFETY: the search field sent its action.
                let value: Retained<NSString> = unsafe { msg_send![sender, stringValue] };
                let id = ITEMS.with(|items| {
                    items.borrow().iter().find(|i| i.kind == "search").map(|i| i.id.clone())
                });
                emit(serde_json::json!({
                    "type": "search",
                    "id": id.unwrap_or_default(),
                    "value": value.to_string(),
                }));
            }
        }

        unsafe impl NSObjectProtocol for Delegate {}
    );

    impl Delegate {
        fn new(mtm: MainThreadMarker) -> Retained<Self> {
            let this = Self::alloc(mtm).set_ivars(());
            // SAFETY: NSObject's designated initializer.
            unsafe { msg_send![super(this), init] }
        }
    }

    fn identifiers() -> Retained<NSArray<NSString>> {
        let ids: Vec<Retained<NSString>> = ITEMS.with(|items| {
            items.borrow().iter().map(|i| NSString::from_str(&i.identifier())).collect()
        });
        NSArray::from_retained_slice(&ids)
    }

    /// The app's id in an item's identifier (`lofu.button.star` → `star`).
    fn id_of(identifier: &str) -> String {
        identifier
            .strip_prefix(PREFIX)
            .and_then(|rest| rest.split_once('.'))
            .map(|(_, id)| id.to_owned())
            .unwrap_or_default()
    }

    unsafe fn color(rgba: [f64; 4]) -> Retained<AnyObject> {
        unsafe {
            msg_send![
                class!(NSColor),
                colorWithSRGBRed: rgba[0],
                green: rgba[1],
                blue: rgba[2],
                alpha: rgba[3]
            ]
        }
    }

    /// The app's window: the main one, else the key one, else the first.
    unsafe fn window() -> Option<Retained<AnyObject>> {
        unsafe {
            let app: Retained<AnyObject> = msg_send![class!(NSApplication), sharedApplication];
            let main: Option<Retained<AnyObject>> = msg_send![&*app, mainWindow];
            if main.is_some() {
                return main;
            }
            let key: Option<Retained<AnyObject>> = msg_send![&*app, keyWindow];
            if key.is_some() {
                return key;
            }
            let windows: Retained<NSArray<AnyObject>> = msg_send![&*app, windows];
            windows.iter().next()
        }
    }

    /// The pointer, from the top left of the window's content (as nsh's
    /// `pagePosition`): where a share picker or menu opened from an item points.
    unsafe fn pointer() -> (f64, f64) {
        unsafe {
            let Some(window) = window() else {
                return (-1.0, -1.0);
            };
            let p: NSPoint = msg_send![&*window, mouseLocationOutsideOfEventStream];
            let content: Option<Retained<AnyObject>> = msg_send![&*window, contentView];
            let height = content
                .map(|c| {
                    let f: NSRect = msg_send![&*c, frame];
                    f.size.height
                })
                .unwrap_or(0.0);
            (p.x, height - p.y)
        }
    }

    /// A toolbar item for `item`, its actions sent to `target`.
    unsafe fn make(item: &Item, target: &Delegate) -> Retained<AnyObject> {
        unsafe {
            let identifier = NSString::from_str(&item.identifier());
            match item.kind.as_str() {
                "search" => {
                    let made: Allocated<AnyObject> = msg_send![class!(NSSearchToolbarItem), alloc];
                    let made: Retained<AnyObject> =
                        msg_send![made, initWithItemIdentifier: &*identifier];
                    let field: Retained<AnyObject> = msg_send![&*made, searchField];
                    let _: () = msg_send![&*field, setTarget: target];
                    let _: () = msg_send![&*field, setAction: sel!(searched:)];
                    // Each edit is sent (the app waits a moment before searching).
                    let _: () = msg_send![&*field, setSendsSearchStringImmediately: true];
                    let _: () = msg_send![&*made, setResignsFirstResponderWithCancel: true];
                    update(&made, item);
                    made
                }
                "space" => {
                    let made: Allocated<AnyObject> = msg_send![class!(NSToolbarItem), alloc];
                    let made: Retained<AnyObject> =
                        msg_send![made, initWithItemIdentifier: &*identifier];
                    let view: Retained<AnyObject> = msg_send![class!(NSView), new];
                    let _: () = msg_send![
                        &*view,
                        setFrame: NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(1.0, 1.0))
                    ];
                    let anchor: Retained<AnyObject> = msg_send![&*view, widthAnchor];
                    let width: Retained<AnyObject> =
                        msg_send![&*anchor, constraintEqualToConstant: 1.0f64];
                    let _: () = msg_send![&*width, setActive: true];
                    let anchor: Retained<AnyObject> = msg_send![&*view, heightAnchor];
                    let height: Retained<AnyObject> =
                        msg_send![&*anchor, constraintEqualToConstant: 1.0f64];
                    let _: () = msg_send![&*height, setActive: true];
                    let _: () = msg_send![&*made, setView: &*view];
                    let _: () = msg_send![&*made, setBordered: false];
                    SPACES.with(|s| s.borrow_mut().insert(item.id.clone(), width));
                    made
                }
                _ => {
                    let made: Allocated<AnyObject> = msg_send![class!(NSToolbarItem), alloc];
                    let made: Retained<AnyObject> =
                        msg_send![made, initWithItemIdentifier: &*identifier];
                    let _: () = msg_send![&*made, setBordered: true];
                    let _: () = msg_send![&*made, setTarget: target];
                    let _: () = msg_send![&*made, setAction: sel!(fire:)];
                    // The app says when an item is enabled, not AppKit's validation.
                    let _: () = msg_send![&*made, setAutovalidates: false];
                    update(&made, item);
                    made
                }
            }
        }
    }

    /// Brings a made item up to date with `item` (same identifier).
    unsafe fn update(made: &AnyObject, item: &Item) {
        unsafe {
            let label = NSString::from_str(&item.label);
            match item.kind.as_str() {
                "search" => {
                    let field: Retained<AnyObject> = msg_send![made, searchField];
                    let placeholder = NSString::from_str(&item.placeholder);
                    let _: () = msg_send![&*field, setPlaceholderString: &*placeholder];
                    let now: Retained<NSString> = msg_send![&*field, stringValue];
                    // Only when it differs: setting it moves the caret to the end.
                    if now.to_string() != item.value {
                        let _: () =
                            msg_send![&*field, setStringValue: &*NSString::from_str(&item.value)];
                    }
                    let _: () = msg_send![made, setPreferredWidthForSearchField: item.width];
                    let _: () = msg_send![made, setLabel: &*label];
                    let _: () = msg_send![&*field, setAccessibilityLabel: &*label];
                    let _: () = msg_send![&*field, setEnabled: !item.disabled];
                }
                "button" => {
                    let _: () = msg_send![made, setLabel: &*label];
                    let _: () = msg_send![made, setToolTip: &*label];
                    if let Some(symbol) = &item.symbol {
                        let mut image: Option<Retained<AnyObject>> = msg_send![
                            class!(NSImage),
                            imageWithSystemSymbolName: &*NSString::from_str(symbol),
                            accessibilityDescription: &*label
                        ];
                        // A plain item draws its symbol in the tint (a
                        // favorite's star); a prominent one is filled with it.
                        if let (Some(tint), Some(i), false) = (item.tint, &image, item.prominent) {
                            let colors = NSArray::from_retained_slice(&[color(tint)]);
                            let palette: Retained<AnyObject> = msg_send![
                                class!(NSImageSymbolConfiguration),
                                configurationWithPaletteColors: &*colors
                            ];
                            image = msg_send![&**i, imageWithSymbolConfiguration: &*palette];
                        }
                        let _: () = msg_send![made, setImage: image.as_deref()];
                    }
                    let styled: bool = msg_send![made, respondsToSelector: sel!(setStyle:)];
                    if styled {
                        // NSToolbarItemStyleProminent (macOS 26), else plain.
                        let style: isize = if item.prominent { 1 } else { 0 };
                        let _: () = msg_send![made, setStyle: style];
                        let tint = item.tint.filter(|_| item.prominent).map(|c| color(c));
                        let _: () = msg_send![made, setBackgroundTintColor: tint.as_deref()];
                    }
                    let _: () = msg_send![made, setEnabled: !item.disabled];
                }
                _ => {}
            }
        }
    }

    /// Widens each `space` item until the next item starts at its `x`. The
    /// toolbar lays its items out from after the window's buttons, which
    /// AppKit places: measured, not assumed.
    unsafe fn fit_spaces() {
        unsafe {
            let spaces: Vec<(Item, Retained<AnyObject>)> = ITEMS.with(|items| {
                items
                    .borrow()
                    .iter()
                    .filter(|i| i.kind == "space")
                    .filter_map(|i| {
                        let made = MADE.with(|m| m.borrow().get(&i.identifier()).cloned())?;
                        Some((i.clone(), made))
                    })
                    .collect()
            });
            for (item, made) in spaces {
                let view: Option<Retained<AnyObject>> = msg_send![&*made, view];
                let Some(view) = view else { continue };
                let window: Option<Retained<AnyObject>> = msg_send![&*view, window];
                if window.is_none() {
                    continue;
                }
                let bounds: NSRect = msg_send![&*view, bounds];
                let at: NSRect = msg_send![
                    &*view,
                    convertRect: bounds,
                    toView: Option::<&AnyObject>::None
                ];
                let width = (item.x - at.origin.x).max(1.0).round();
                if let Some(constraint) = SPACES.with(|s| s.borrow().get(&item.id).cloned()) {
                    let now: f64 = msg_send![&*constraint, constant];
                    if (now - width).abs() >= 1.0 {
                        let _: () = msg_send![&*constraint, setConstant: width];
                    }
                }
            }
        }
    }

    /// Shows `items` (JSON, see `Item`) in the window's toolbar.
    pub fn set(items: String) {
        let Ok(Value::Array(items)) = serde_json::from_str::<Value>(&items) else {
            return;
        };
        let items: Vec<Item> = items.iter().filter_map(Item::parse).collect();
        dispatch2::DispatchQueue::main().exec_async(move || {
            // SAFETY: on the main thread, with AppKit's own classes.
            unsafe { apply(items) };
        });
    }

    /// Opens the search field for typing (⌘F).
    pub fn search() {
        dispatch2::DispatchQueue::main().exec_async(|| {
            let made = MADE.with(|m| {
                m.borrow()
                    .iter()
                    .find(|(k, _)| k.starts_with(&format!("{PREFIX}search.")))
                    .map(|(_, v)| v.clone())
            });
            if let Some(made) = made {
                // SAFETY: an NSSearchToolbarItem, on the main thread.
                unsafe {
                    let _: () = msg_send![&*made, beginSearchInteraction];
                }
            }
        });
    }

    unsafe fn apply(items: Vec<Item>) {
        unsafe {
            let Some(window) = window() else { return };
            let before: Vec<String> =
                ITEMS.with(|i| i.borrow().iter().map(Item::identifier).collect());
            let after: Vec<String> = items.iter().map(Item::identifier).collect();
            ITEMS.with(|i| *i.borrow_mut() = items.clone());

            let installed = TOOLBAR.with(|t| t.borrow().as_ref().map(|(tb, _)| tb.clone()));
            let current: Option<Retained<AnyObject>> = msg_send![&*window, toolbar];
            let ours = matches!((&installed, &current), (Some(a), Some(b)) if std::ptr::eq(&**a, &**b));
            if !ours {
                let mtm = MainThreadMarker::new().expect("on the main thread");
                let delegate = Delegate::new(mtm);
                let toolbar: Allocated<AnyObject> = msg_send![class!(NSToolbar), alloc];
                let toolbar: Retained<AnyObject> = msg_send![
                    toolbar,
                    initWithIdentifier: &*NSString::from_str("lofu.window")
                ];
                let _: () = msg_send![&*toolbar, setDelegate: &*delegate];
                // NSToolbarDisplayModeIconOnly
                let _: () = msg_send![&*toolbar, setDisplayMode: 2usize];
                let _: () = msg_send![&*toolbar, setAllowsUserCustomization: false];
                let _: () = msg_send![&*toolbar, setAutosavesConfiguration: false];
                MADE.with(|m| m.borrow_mut().clear());
                SPACES.with(|s| s.borrow_mut().clear());
                let _: () = msg_send![&*window, setToolbar: &*toolbar];
                // NSWindowToolbarStyleUnified: the height nsh's title bar asked for.
                let _: () = msg_send![&*window, setToolbarStyle: 3isize];
                TOOLBAR.with(|t| *t.borrow_mut() = Some((toolbar, delegate)));
            } else if before != after {
                let toolbar = installed.expect("ours");
                let count = |tb: &AnyObject| -> usize {
                    let items: Retained<NSArray<AnyObject>> = msg_send![tb, items];
                    items.count()
                };
                while count(&toolbar) > 0 {
                    let _: () = msg_send![&*toolbar, removeItemAtIndex: 0isize];
                }
                MADE.with(|m| m.borrow_mut().clear());
                SPACES.with(|s| s.borrow_mut().clear());
                for (i, identifier) in after.iter().enumerate() {
                    let _: () = msg_send![
                        &*toolbar,
                        insertItemWithItemIdentifier: &*NSString::from_str(identifier),
                        atIndex: i as isize
                    ];
                }
            } else {
                for item in &items {
                    let made = MADE.with(|m| m.borrow().get(&item.identifier()).cloned());
                    if let Some(made) = made {
                        update(&made, item);
                    }
                }
            }
            fit_spaces();
            // The toolbar lays out the items it just took a moment later.
            dispatch2::DispatchQueue::main().exec_async(|| fit_spaces());
        }
    }
}
