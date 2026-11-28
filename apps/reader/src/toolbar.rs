//! The window's toolbar on macOS: a real `NSToolbar`, whose items AppKit
//! draws in Liquid Glass on macOS 26 (bordered symbols that it groups into
//! capsules, a prominent item filled with its tint, the system's search
//! field). nsh's hidden title bar already puts an empty toolbar on the
//! window for its height; this one takes its place, and nsh leaves a
//! toolbar it didn't install alone.
//!
//! The items sit in the title bar, outside nsh's root view, so clicks reach
//! them as they reach any AppKit control (inside the root, nsh 0.4 and 0.5 lose a
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

/// Whether the app shows suggestions under the search field: the field
/// then hands it the arrow keys, Return and Escape instead of using them.
static SUGGESTING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Tells the toolbar whether the app's suggestions are open under its search field.
pub fn suggesting(on: bool) {
    SUGGESTING.store(on, std::sync::atomic::Ordering::Relaxed);
}

/// The next click or search edit, as JSON: `{ type: "press", id, x, y }`
/// (the pointer, from the window's top left), `{ type: "search", id, value }`,
/// `{ type: "searchFocus", id, x, y, width, height }` (the field took the
/// keyboard; its frame, from the window's top left), `{ type: "searchBlur",
/// id }`, or `{ type: "searchKey", id, key }` (`up`, `down`, `enter`,
/// `escape`; the arrows and Escape only while `suggesting`), or
/// `{ type: "mark", id, right, left }` (where the items after a `mark` start,
/// `right` points from the window's right edge, and where its slot starts,
/// `left` points from the window's left edge: just after the item before it;
/// when either moved);
/// "" after a second without one. The app asks again at once; the timeout
/// lets a JS context that's gone (a hot reload) stop waiting, instead of
/// holding the queue and taking the next event from the one that's live.
#[cfg(not(target_arch = "wasm32"))]
pub async fn next() -> String {
    nsh_core::prelude::blocking(|| {
        let rx = events().1.lock().unwrap_or_else(|e| e.into_inner());
        rx.recv_timeout(std::time::Duration::from_secs(1))
            .unwrap_or_default()
    })
    .await
    .unwrap_or_default()
}

/// The web has no toolbar of the app's (`available()` is false, so the app
/// never asks) and no threads to wait on.
#[cfg(target_arch = "wasm32")]
pub async fn next() -> String {
    String::new()
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
    use objc2::runtime::{AnyObject, Bool, NSObject, NSObjectProtocol, Sel};
    use objc2::{ClassType, MainThreadMarker, MainThreadOnly, class, define_class, msg_send, sel};
    use objc2_app_kit::{NSControl, NSResponder, NSSearchField, NSTextField, NSView};
    use objc2_foundation::{NSArray, NSPoint, NSRange, NSRect, NSSize, NSString};
    use serde_json::Value;

    use super::{SUGGESTING, emit};

    const FLEX: &str = "NSToolbarFlexibleSpaceItem";
    const GAP: &str = "NSToolbarSpaceItem";
    const PREFIX: &str = "lofu.";

    /// One item, as TSX describes it.
    #[derive(Clone, PartialEq)]
    struct Item {
        id: String,
        /// `button`, `search`, `space` (leading room, up to `x`), `flex`, `gap`,
        /// `mark` (an invisible point whose place is reported, `report_marks`).
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
        /// Numbers the toolbars made, for their identifiers.
        static SERIAL: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
        /// Where each `mark` was last reported (`right`, `left`).
        static MARKS: RefCell<HashMap<String, (f64, f64)>> = RefCell::new(HashMap::new());
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
                // Where the search field is now: what a panel opened from a
                // button beside it (the filters) goes under.
                let search = search_item().map(|made| {
                    // SAFETY: an NSSearchToolbarItem, on the main thread.
                    let (x, y, width, height) = unsafe {
                        let field: Retained<AnyObject> = msg_send![&*made, searchField];
                        frame_in_window(&field)
                    };
                    serde_json::json!({ "x": x, "y": y, "width": width, "height": height })
                });
                emit(serde_json::json!({
                    "type": "press",
                    "id": id_of(&identifier.to_string()),
                    "x": x,
                    "y": y,
                    "search": search,
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

            /// The window changed size: the items at the trailing end moved
            /// (and the search field may have narrowed), once AppKit has laid
            /// the toolbar out again.
            #[unsafe(method(windowDidResize:))]
            fn window_did_resize(&self, _notification: &AnyObject) {
                // SAFETY: report_marks runs on the main thread.
                dispatch2::DispatchQueue::main().exec_async(|| unsafe { report_marks() });
            }

            /// The search field opened out, folded into a button or narrowed:
            /// it pushes the items before it into the overflow and back.
            #[unsafe(method(searchFieldMoved:))]
            fn search_field_moved(&self, _notification: &AnyObject) {
                // SAFETY: report_marks runs on the main thread.
                dispatch2::DispatchQueue::main().exec_async(|| unsafe { report_marks() });
            }

            /// The search field's editing ended: it lost the keyboard, unless
            /// it still has it on the next turn. A click into the field ends
            /// editing during the click itself, right after the field took
            /// the keyboard, which closed the suggestions it had just opened.
            #[unsafe(method(controlTextDidEndEditing:))]
            fn did_end_editing(&self, _notification: &AnyObject) {
                dispatch2::DispatchQueue::main().exec_async(|| {
                    // SAFETY: an NSSearchToolbarItem's field, on the main thread.
                    let editing = search_item().is_some_and(|made| unsafe {
                        let field: Retained<AnyObject> = msg_send![&*made, searchField];
                        editing(&field)
                    });
                    if editing {
                        return;
                    }
                    emit(serde_json::json!({ "type": "searchBlur", "id": search_id() }));
                });
            }

            /// The keys the app's suggestions take: the arrows and Escape
            /// while they're open, and Return always (the field's action
            /// doesn't say it was Return).
            #[unsafe(method(control:textView:doCommandBySelector:))]
            fn do_command(&self, _control: &AnyObject, _text_view: &AnyObject, command: Sel) -> Bool {
                let suggesting = SUGGESTING.load(std::sync::atomic::Ordering::Relaxed);
                let key = if command == sel!(moveUp:) {
                    "up"
                } else if command == sel!(moveDown:) {
                    "down"
                } else if command == sel!(insertNewline:) {
                    "enter"
                } else if command == sel!(cancelOperation:) {
                    "escape"
                } else {
                    return Bool::NO;
                };
                if key != "enter" && !suggesting {
                    return Bool::NO;
                }
                emit(serde_json::json!({ "type": "searchKey", "id": search_id(), "key": key }));
                Bool::new(suggesting)
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

    /// The id of the search item the app gave.
    fn search_id() -> String {
        ITEMS.with(|items| {
            items.borrow().iter().find(|i| i.kind == "search").map(|i| i.id.clone())
        })
        .unwrap_or_default()
    }

    define_class!(
        /// The toolbar's search field, which says when it takes the keyboard
        /// (a field's delegate hears of editing only once the text changes):
        /// a click, or the app making it first responder. ⌘F's
        /// `beginSearchInteraction` hands the keyboard to the field editor
        /// without either, so `search` says so itself.
        #[unsafe(super(NSSearchField, NSTextField, NSControl, NSView, NSResponder, NSObject))]
        #[thread_kind = MainThreadOnly]
        #[name = "LofuSearchField"]
        struct SearchField;

        impl SearchField {
            #[unsafe(method(becomeFirstResponder))]
            fn become_first_responder(&self) -> Bool {
                // SAFETY: NSResponder's own method, on the main thread.
                let took: bool = unsafe { msg_send![super(self), becomeFirstResponder] };
                if took {
                    // SAFETY: a view, on the main thread.
                    unsafe { emit_focus(self) };
                }
                Bool::new(took)
            }

            #[unsafe(method(mouseDown:))]
            fn mouse_down(&self, event: &AnyObject) {
                // SAFETY: a view, on the main thread.
                unsafe { emit_focus(self) };
                // SAFETY: NSResponder's own method, on the main thread.
                unsafe {
                    let _: () = msg_send![super(self), mouseDown: event];
                }
            }
        }
    );

    /// Whether `field` has the keyboard: its window's first responder is the
    /// field editor editing it.
    unsafe fn editing(field: &AnyObject) -> bool {
        unsafe {
            let editor: Option<Retained<AnyObject>> = msg_send![field, currentEditor];
            let window: Option<Retained<AnyObject>> = msg_send![field, window];
            let (Some(editor), Some(window)) = (editor, window) else {
                return false;
            };
            let first: Option<Retained<AnyObject>> = msg_send![&*window, firstResponder];
            first.is_some_and(|f| std::ptr::eq(&*f, &*editor))
        }
    }

    /// Tells the app the search field has the keyboard, and where it is.
    unsafe fn emit_focus(field: &AnyObject) {
        // SAFETY: a view, on the main thread.
        let (x, y, width, height) = unsafe { frame_in_window(field) };
        emit(serde_json::json!({
            "type": "searchFocus",
            "id": search_id(),
            "x": x,
            "y": y,
            "width": width,
            "height": height,
        }));
    }

    /// A view's frame from the top left of the window's content (as `pointer`).
    unsafe fn frame_in_window(view: &AnyObject) -> (f64, f64, f64, f64) {
        unsafe {
            let bounds: NSRect = msg_send![view, bounds];
            let at: NSRect = msg_send![view, convertRect: bounds, toView: Option::<&AnyObject>::None];
            let window: Option<Retained<AnyObject>> = msg_send![view, window];
            let content: Option<Retained<AnyObject>> =
                window.and_then(|w| msg_send![&*w, contentView]);
            let height = content
                .map(|c| {
                    let f: NSRect = msg_send![&*c, frame];
                    f.size.height
                })
                .unwrap_or(0.0);
            (
                at.origin.x,
                height - at.origin.y - at.size.height,
                at.size.width,
                at.size.height,
            )
        }
    }

    fn identifiers() -> Retained<NSArray<NSString>> {
        let ids: Vec<Retained<NSString>> = ITEMS.with(|items| {
            items.borrow().iter().map(|i| NSString::from_str(&i.identifier())).collect()
        });
        NSArray::from_retained_slice(&ids)
    }

    define_class!(
        /// A `space` item's view, which fits the spaces again once AppKit has
        /// put it in the window: the toolbar lays out the items it takes a
        /// moment after they're inserted, and in a release build that's
        /// later than `apply`'s next turn, which left Back over the sidebar.
        #[unsafe(super(NSView, NSResponder, NSObject))]
        #[thread_kind = MainThreadOnly]
        #[name = "LofuToolbarSpace"]
        struct SpaceView;

        impl SpaceView {
            #[unsafe(method(viewDidMoveToWindow))]
            fn did_move_to_window(&self) {
                // SAFETY: NSView's own method, on the main thread.
                unsafe {
                    let _: () = msg_send![super(self), viewDidMoveToWindow];
                }
                // After the layout that placed it.
                // SAFETY: fit_spaces runs on the main thread.
                dispatch2::DispatchQueue::main().exec_async(|| unsafe { fit_spaces() });
            }
        }
    );

    define_class!(
        /// A `mark` item's view: reports its place once AppKit has put it in
        /// the window.
        #[unsafe(super(NSView, NSResponder, NSObject))]
        #[thread_kind = MainThreadOnly]
        #[name = "LofuToolbarMark"]
        struct MarkView;

        impl MarkView {
            #[unsafe(method(viewDidMoveToWindow))]
            fn did_move_to_window(&self) {
                // SAFETY: NSView's own method, on the main thread.
                unsafe {
                    let _: () = msg_send![super(self), viewDidMoveToWindow];
                }
                // SAFETY: report_marks runs on the main thread.
                dispatch2::DispatchQueue::main().exec_async(|| unsafe { report_marks() });
            }
        }
    );

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
                    let field: Retained<AnyObject> = msg_send![SearchField::class(), new];
                    let _: () = msg_send![&*made, setSearchField: &*field];
                    let _: () = msg_send![&*field, setDelegate: target];
                    let _: () = msg_send![&*field, setTarget: target];
                    let _: () = msg_send![&*field, setAction: sel!(searched:)];
                    // Each edit is sent (the app waits a moment before searching).
                    let _: () = msg_send![&*field, setSendsSearchStringImmediately: true];
                    let _: () = msg_send![&*made, setResignsFirstResponderWithCancel: true];
                    let _: () = msg_send![&*field, setPostsFrameChangedNotifications: true];
                    let center: Retained<AnyObject> =
                        msg_send![class!(NSNotificationCenter), defaultCenter];
                    let _: () = msg_send![
                        &*center,
                        addObserver: target,
                        selector: sel!(searchFieldMoved:),
                        name: &*NSString::from_str("NSViewFrameDidChangeNotification"),
                        object: &*field
                    ];
                    update(&made, item);
                    made
                }
                "mark" => {
                    let made: Allocated<AnyObject> = msg_send![class!(NSToolbarItem), alloc];
                    let made: Retained<AnyObject> =
                        msg_send![made, initWithItemIdentifier: &*identifier];
                    let view: Retained<AnyObject> = msg_send![MarkView::class(), new];
                    for anchor in [sel!(widthAnchor), sel!(heightAnchor)] {
                        let anchor: Retained<AnyObject> = msg_send![&*view, performSelector: anchor];
                        let size: Retained<AnyObject> =
                            msg_send![&*anchor, constraintEqualToConstant: 1.0f64];
                        let _: () = msg_send![&*size, setActive: true];
                    }
                    let _: () = msg_send![&*made, setView: &*view];
                    let _: () = msg_send![&*made, setBordered: false];
                    made
                }
                "space" => {
                    let made: Allocated<AnyObject> = msg_send![class!(NSToolbarItem), alloc];
                    let made: Retained<AnyObject> =
                        msg_send![made, initWithItemIdentifier: &*identifier];
                    let view: Retained<AnyObject> = msg_send![SpaceView::class(), new];
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
                        let value = NSString::from_str(&item.value);
                        // While it's being typed in (a suggestion picked), through
                        // the field editor: `setStringValue:` would end the editing
                        // and take the keyboard away.
                        let editor: Option<Retained<AnyObject>> = msg_send![&*field, currentEditor];
                        if let Some(editor) = editor {
                            let _: () = msg_send![&*editor, setString: &*value];
                            let end = NSRange::new(value.length(), 0);
                            let _: () = msg_send![&*editor, setSelectedRange: end];
                        } else {
                            let _: () = msg_send![&*field, setStringValue: &*value];
                        }
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
                let Some(window) = window else { continue };
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
                        // Laid out now, so the marks read next are where
                        // the items went (the sidebar's ⌘B moves them).
                        let _: () = msg_send![&*window, layoutIfNeeded];
                    }
                }
            }
        }
    }

    /// Tells each `mark` where it is, when that moved by a point or more:
    /// `right`, where the items after it start, from the window's right edge
    /// (the left edge of the first one shown: on macOS 26 its glass capsule,
    /// a sibling of the mark's 36-point slot, or the overflow chevron when
    /// the search field has pushed items into it; else the slot's right
    /// edge), and `left`, where its slot starts, from the window's left edge
    /// (just after the item before it). The trailing items keep their
    /// distance from the window's right edge as it resizes, so this rarely
    /// changes during a live resize (only as the search field narrows).
    unsafe fn report_marks() {
        unsafe {
            let marks: Vec<(String, Retained<AnyObject>)> = ITEMS.with(|items| {
                items
                    .borrow()
                    .iter()
                    .filter(|i| i.kind == "mark")
                    .filter_map(|i| {
                        let made = MADE.with(|m| m.borrow().get(&i.identifier()).cloned())?;
                        Some((i.id.clone(), made))
                    })
                    .collect()
            });
            for (id, made) in marks {
                let view: Option<Retained<AnyObject>> = msg_send![&*made, view];
                let Some(view) = view else { continue };
                let window: Option<Retained<AnyObject>> = msg_send![&*view, window];
                let Some(window) = window else { continue };
                let frame: NSRect = msg_send![&*window, frame];
                let slot: Option<Retained<AnyObject>> = msg_send![&*view, superview];
                let Some(slot) = slot else { continue };
                let (slot_x, _, slot_w, _) = frame_in_window(&slot);
                // From the slot's left edge: AppKit's overflow chevron, when
                // the search field has opened out over the items, overlaps it.
                let after = slot_x - 1.0;
                let mut x = slot_x + slot_w;
                let container: Option<Retained<AnyObject>> = msg_send![&*slot, superview];
                if let Some(container) = container {
                    let shown: Retained<NSArray<AnyObject>> = msg_send![&*container, subviews];
                    for other in shown.iter() {
                        let hidden: bool = msg_send![&*other, isHiddenOrHasHiddenAncestor];
                        let alpha: f64 = msg_send![&*other, alphaValue];
                        let (ox, _, ow, _) = frame_in_window(&other);
                        if !hidden && alpha > 0.0 && ow > 0.0 && ox >= after {
                            x = x.min(ox);
                        }
                    }
                }
                let right = (frame.size.width - x).round();
                // The slot follows the item before it (its glass, on macOS 26).
                let left = slot_x.round();
                let moved = MARKS.with(|m| {
                    let mut m = m.borrow_mut();
                    let moved = m.get(&id).is_none_or(|(r, l)| {
                        (r - right).abs() >= 1.0 || (l - left).abs() >= 1.0
                    });
                    if moved {
                        m.insert(id.clone(), (right, left));
                    }
                    moved
                });
                if moved {
                    emit(serde_json::json!({ "type": "mark", "id": id, "right": right, "left": left }));
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

    /// The item with toolbar identifier `identifier` among those to show.
    fn items_now(identifier: &str) -> Option<Item> {
        ITEMS.with(|items| {
            items.borrow().iter().find(|i| i.identifier() == identifier).cloned()
        })
    }

    /// The toolbar's search item, if it shows one.
    fn search_item() -> Option<Retained<AnyObject>> {
        MADE.with(|m| {
            m.borrow()
                .iter()
                .find(|(k, _)| k.starts_with(&format!("{PREFIX}search.")))
                .map(|(_, v)| v.clone())
        })
    }

    /// Opens the search field for typing (⌘F).
    pub fn search() {
        dispatch2::DispatchQueue::main().exec_async(|| {
            if let Some(made) = search_item() {
                // SAFETY: an NSSearchToolbarItem, on the main thread.
                unsafe {
                    let _: () = msg_send![&*made, beginSearchInteraction];
                }
                // Once the item has opened out (it may be collapsed to a button).
                dispatch2::DispatchQueue::main().exec_async(|| {
                    if let Some(made) = search_item() {
                        // SAFETY: an NSSearchToolbarItem, on the main thread.
                        unsafe {
                            let field: Retained<AnyObject> = msg_send![&*made, searchField];
                            emit_focus(&field);
                        }
                    }
                });
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
                // A fresh identifier each time: toolbars sharing one are a
                // family, and AppKit inserts an item into every toolbar of
                // the family at the same index, which throws once an older
                // one (still alive, or on another window) has fewer items.
                let serial = SERIAL.with(|n| {
                    n.set(n.get() + 1);
                    n.get()
                });
                let toolbar: Retained<AnyObject> = msg_send![
                    toolbar,
                    initWithIdentifier: &*NSString::from_str(&format!("lofu.window.{serial}"))
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
                // Where the `mark` items are, as the window resizes.
                let center: Retained<AnyObject> =
                    msg_send![class!(NSNotificationCenter), defaultCenter];
                let _: () = msg_send![
                    &*center,
                    addObserver: &*delegate,
                    selector: sel!(windowDidResize:),
                    name: &*NSString::from_str("NSWindowDidResizeNotification"),
                    object: &*window
                ];
                TOOLBAR.with(|t| *t.borrow_mut() = Some((toolbar, delegate)));
            } else if before != after {
                let toolbar = installed.expect("ours");
                // The search item stays, hidden while other pages' items
                // show: a new `NSSearchToolbarItem` comes in folded into its
                // button and opens out, the button's magnifier fading at the
                // field's end (going back to the library flashed it), and
                // AppKit wants a new item each time it asks for one, so the
                // old one can't be handed back. Items can hide from macOS 15.
                // From the toolbar's own items: a hidden one isn't in `MADE`.
                let items: Retained<NSArray<AnyObject>> = msg_send![&*toolbar, items];
                let kept = items.iter().find(|made| {
                    let id: Retained<NSString> = msg_send![&**made, itemIdentifier];
                    let hides: bool = msg_send![&**made, respondsToSelector: sel!(setHidden:)];
                    hides && id.to_string().starts_with(&format!("{PREFIX}search."))
                });
                let kept_id = kept.as_ref().map(|made| {
                    let id: Retained<NSString> = msg_send![&**made, itemIdentifier];
                    id.to_string()
                });
                for i in (0..items.count()).rev() {
                    let id: Retained<NSString> =
                        msg_send![&*items.objectAtIndex(i), itemIdentifier];
                    if kept_id.as_deref() != Some(&*id.to_string()) {
                        let _: () = msg_send![&*toolbar, removeItemAtIndex: i as isize];
                    }
                }
                MADE.with(|m| m.borrow_mut().clear());
                SPACES.with(|s| s.borrow_mut().clear());
                // Inserted around the kept item: those before its place
                // push it along, so it ends up where the new items have it
                // (or last, out of the way, when they have none).
                for (i, identifier) in after.iter().enumerate() {
                    if kept_id.as_deref() == Some(identifier.as_str()) {
                        continue;
                    }
                    let _: () = msg_send![
                        &*toolbar,
                        insertItemWithItemIdentifier: &*NSString::from_str(identifier),
                        atIndex: i as isize
                    ];
                }
                if let (Some(made), Some(id)) = (kept, kept_id) {
                    let item = items_now(&id);
                    let _: () = msg_send![&*made, setHidden: item.is_none()];
                    if let Some(item) = item {
                        update(&made, &item);
                        MADE.with(|m| m.borrow_mut().insert(id, made));
                    }
                }
            } else {
                for item in &items {
                    let made = MADE.with(|m| m.borrow().get(&item.identifier()).cloned());
                    if let Some(made) = made {
                        update(&made, item);
                    }
                }
            }
            // Told again: a page that just asked for these items (another
            // library over the same ids) hasn't heard where they are.
            MARKS.with(|m| m.borrow_mut().clear());
            fit_spaces();
            report_marks();
            // The toolbar lays out the items it just took a moment later.
            dispatch2::DispatchQueue::main().exec_async(|| {
                fit_spaces();
                report_marks();
            });
        }
    }
}
