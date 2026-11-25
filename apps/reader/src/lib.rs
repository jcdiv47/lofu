//! What the app needs from the platform that nsh doesn't offer: the system's
//! menu from a point on iOS (`PopupMenu`), the login
//! the iOS share extension (`share/`) saves with, and the system's own glass
//! buttons (and, on iOS, search field) as native components (`controls`,
//! used through `components/native.tsx`). TSX imports the modules from
//! `lofu/native`; their TypeScript declarations are
//! generated into `.nsh/types/lofu/native.d.ts`.

use nsh_core::prelude::*;

#[cfg(any(target_os = "ios", target_os = "macos"))]
mod controls;
#[cfg(target_os = "ios")]
mod edges;
#[cfg(target_os = "ios")]
mod glassbar;
#[cfg(target_os = "ios")]
mod prompt;

/// UIKit's controls (`controls::ios`), registered on every view.
#[cfg(target_os = "ios")]
#[native_components(ios)]
fn ios_components(components: &nsh_platform_ios::Components) {
    controls::ios::register(components);
    edges::register(components);
    glassbar::register(components);
}

/// AppKit's controls (`controls::macos`), registered on every view.
#[cfg(target_os = "macos")]
#[native_components(macos)]
fn macos_components(components: &nsh_platform_macos::Components) {
    controls::macos::register(components);
}

/// The crate's UI set (`nsh.json` `"rust"`).
#[native_module("lofu/native")]
fn native(registry: &mut Registry) {
    registry.module::<PopupMenu>();
    registry.module::<Toolbar>();
    registry.module::<Swipe>();
    registry.module::<Sidebar>();
    registry.module::<Controls>();
    registry.module::<TextPrompt>();
    registry.module::<Keyboard>();
    registry.module::<EditMenu>();
    registry.module::<ShareExtension>();
    registry.module::<files::Files>();
    registry.module::<files::Secrets>();
}

mod editmenu;
mod files;
mod sidebar;
mod swipe;
mod toolbar;

/// Swiping back with two fingers on the Mac's trackpad (`src/swipe.rs`).
#[module]
pub struct Swipe;

#[module]
impl Swipe {
    /// Whether there are trackpad swipes to hear here (macOS).
    pub fn available() -> bool {
        cfg!(target_os = "macos")
    }

    /// Whether a swipe may go back now: the app has a page to go back to
    /// and no dialog in the way. The first call starts watching.
    pub fn enable(on: bool) {
        swipe::enable(on)
    }

    /// Whether a swipe went back: true when one did (the page is off to
    /// the right, for the app to pop), false after a second without one.
    pub async fn next() -> bool {
        swipe::next().await
    }
}

/// The window's sidebar on macOS (`src/sidebar.rs`): the system's own,
/// which AppKit draws in Liquid Glass on macOS 26, under nsh's root view.
#[module]
pub struct Sidebar;

#[module]
impl Sidebar {
    /// Whether the window can have the system's sidebar here (macOS).
    pub fn available() -> bool {
        cfg!(target_os = "macos")
    }

    /// Puts the system's sidebar, `width` points wide, under the window's
    /// content: the app draws the sidebar's rows over it, on a transparent
    /// background.
    pub fn show(width: f64) {
        sidebar::show(width)
    }

    /// Takes the system's sidebar away.
    pub fn hide() {
        sidebar::hide()
    }
}

/// The window's toolbar on macOS (`src/toolbar.rs`): a real `NSToolbar`,
/// which AppKit draws in Liquid Glass on macOS 26.
#[module]
pub struct Toolbar;

#[module]
impl Toolbar {
    /// Whether the window has a toolbar of the app's here (macOS).
    pub fn available() -> bool {
        cfg!(target_os = "macos")
    }

    /// Shows `items` (JSON: `[{ kind: "button", id, symbol, label, tint?,
    /// prominent?, disabled? } | { kind: "search", id, label, placeholder,
    /// value, width? } | { kind: "space", id, x } | { kind: "flex" } |
    /// { kind: "gap" }]`) in the window's toolbar. A `space` widens until the
    /// next item starts `x` points from the window's left edge; `gap` parts
    /// two groups of glass.
    pub fn set(items: String) {
        toolbar::set(items)
    }

    /// The next click or search edit, as JSON: `{ type: "press", id, x, y,
    /// search }` (the pointer, from the window's top left, and the search
    /// field's frame, or null), `{ type: "search", id,
    /// value }`, `{ type: "searchFocus", id, x, y, width, height }` (the
    /// field's frame), `{ type: "searchBlur", id }` or `{ type: "searchKey",
    /// id, key }` (`up`, `down`, `enter`, `escape`).
    pub async fn next() -> String {
        toolbar::next().await
    }

    /// Puts the keyboard in the toolbar's search field (⌘F).
    pub fn search() {
        toolbar::search()
    }

    /// Whether the app's suggestions are open under the search field: while
    /// they are, the field hands it the arrow keys and Escape
    /// (`{ type: "searchKey" }` from `next`).
    pub fn suggesting(on: bool) {
        toolbar::suggesting(on)
    }
}

/// The iOS share extension (`share/`): "lofu" in other apps' share sheets.
/// It saves with the app's server address and token, which it reads from a
/// Keychain group the two share. `share/package.ts` names the group in the
/// app's Info.plist (`LofuKeychainGroup`); a build without the extension has
/// none, and there is nothing to share.
#[module]
pub struct ShareExtension;

#[module]
impl ShareExtension {
    /// Hands the extension the server address and token, or forgets them
    /// when both are empty. Returns whether the extension can save with
    /// them: false without the extension, or when the Keychain refuses.
    pub fn remember(server: String, token: String) -> bool {
        login::remember(&server, &token)
    }
}

#[cfg(not(target_os = "ios"))]
mod login {
    pub fn remember(_server: &str, _token: &str) -> bool {
        false
    }
}

#[cfg(target_os = "ios")]
mod login {
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};
    use objc2_foundation::NSString;
    use security_framework::passwords::{
        PasswordOptions, delete_generic_password_options, set_generic_password_options,
    };

    /// The item both read: `share/Sources/Login.swift` looks for the same.
    const SERVICE: &str = "app.lofu.reader";
    const ACCOUNT: &str = "login";

    /// The group in the app's Info.plist, from `share/package.ts`.
    fn group() -> Option<String> {
        // SAFETY: NSBundle is thread-safe; the value is a string or absent.
        unsafe {
            let bundle: Retained<AnyObject> = msg_send![class!(NSBundle), mainBundle];
            let key = NSString::from_str("LofuKeychainGroup");
            let value: Option<Retained<AnyObject>> =
                msg_send![&*bundle, objectForInfoDictionaryKey: &*key];
            let s = value?.downcast::<NSString>().ok()?;
            Some(s.to_string()).filter(|s| !s.is_empty())
        }
    }

    fn options(group: &str) -> PasswordOptions {
        let mut o = PasswordOptions::new_generic_password(SERVICE, ACCOUNT);
        o.set_access_group(group);
        o
    }

    pub fn remember(server: &str, token: &str) -> bool {
        let Some(group) = group() else {
            return false;
        };
        if server.is_empty() && token.is_empty() {
            return delete_generic_password_options(options(&group)).is_ok();
        }
        let login = serde_json::json!({ "server": server, "token": token }).to_string();
        set_generic_password_options(login.as_bytes(), options(&group)).is_ok()
    }
}

/// The native controls (`controls`).
#[module]
pub struct Controls;

#[module]
impl Controls {
    /// Whether the native controls are registered here: `lofu.glassButton`
    /// on iOS and macOS, `lofu.searchField` on iOS. They draw Liquid Glass
    /// from iOS 26 and macOS 26.
    pub fn available() -> bool {
        cfg!(any(target_os = "ios", target_os = "macos"))
    }

    /// Whether `lofu.scrollEdge` (`src/edges.rs`) gives the page the
    /// system's scroll edge effect: iOS 26 and later.
    pub fn scroll_edges() -> bool {
        #[cfg(target_os = "ios")]
        return edges::available();
        #[cfg(not(target_os = "ios"))]
        false
    }
}

/// The software keyboard, kept away from a read-only `RichEditor` (iOS).
/// The editor takes presses through a hidden text view of nsh's at the
/// caret, which it focuses on every press, editable or not; UIKit then
/// raises the keyboard for it. An empty `inputView` keeps the keyboard down
/// while the text view stays first responder, so selecting, the edit menu
/// and ⌘C still work.
#[module]
pub struct Keyboard;

#[module]
impl Keyboard {
    /// Gives every text view in the view labelled `label` (an editor's
    /// `accessibilityLabel`) an empty input view. Again for the same views
    /// does nothing; call it after the editor mounts and when it takes the
    /// focus, should nsh have made its text view again.
    pub fn keep_away(label: String) {
        #[cfg(target_os = "ios")]
        quiet::keep_away(label);
        #[cfg(not(target_os = "ios"))]
        let _ = label;
    }
}

/// An item of the app's in the system's edit menu over a read-only
/// `RichEditor` (iOS, `src/editmenu.rs`): the reader's *Highlight* beside
/// Copy and Select All. nsh opens that menu itself and takes no items of the
/// app's for an editor.
#[module]
pub struct EditMenu;

#[module]
impl EditMenu {
    /// Whether `offer` puts items in the menu here: iOS.
    pub fn available() -> bool {
        cfg!(target_os = "ios")
    }

    /// Puts an item titled `title` first in the edit menu of the editor
    /// labelled `label` (its `accessibilityLabel`). Again for the same views
    /// only changes the title; call it after the editor mounts and when it
    /// takes the focus, should nsh have made its text view again.
    pub fn offer(label: String, title: String) {
        editmenu::offer(label, title)
    }

    /// The label of the editor whose item was chosen, or "" after a second
    /// without one. The app asks again at once.
    pub async fn next() -> String {
        editmenu::next().await
    }
}

#[cfg(target_os = "ios")]
mod quiet {
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};
    use objc2_foundation::{NSArray, NSString};

    pub fn keep_away(label: String) {
        dispatch2::DispatchQueue::main().exec_async(move || {
            // SAFETY: on the main thread, with UIKit's own classes.
            unsafe {
                if let Some(window) = super::window::key() {
                    walk(&window, &label, false);
                }
            }
        });
    }

    /// Text views under `view`, those inside a view labelled `label` given
    /// an empty input view.
    unsafe fn walk(view: &AnyObject, label: &str, inside: bool) {
        unsafe {
            let own: Option<Retained<NSString>> = msg_send![view, accessibilityLabel];
            let inside = inside || own.is_some_and(|l| l.to_string() == label);
            if inside && msg_send![view, isKindOfClass: class!(UITextView)] {
                quiet(view);
            }
            let subviews: Retained<NSArray<AnyObject>> = msg_send![view, subviews];
            for v in subviews.iter() {
                walk(&v, label, inside);
            }
        }
    }

    unsafe fn quiet(text: &AnyObject) {
        unsafe {
            let current: Option<Retained<AnyObject>> = msg_send![text, inputView];
            if current.is_some() {
                return;
            }
            let empty: Retained<AnyObject> = msg_send![class!(UIView), new];
            let _: () = msg_send![text, setInputView: &*empty];
            // iPad: no shortcuts bar over the missing keyboard either.
            let item: Retained<AnyObject> = msg_send![text, inputAssistantItem];
            let none = NSArray::<AnyObject>::new();
            let _: () = msg_send![&*item, setLeadingBarButtonGroups: &*none];
            let _: () = msg_send![&*item, setTrailingBarButtonGroups: &*none];
            let first: bool = msg_send![text, isFirstResponder];
            if first {
                let _: () = msg_send![text, reloadInputViews];
            }
        }
    }
}

/// Asks for a line of text (a new name) with the system's alert, which iOS
/// 26 draws in Liquid Glass (`src/prompt.rs`). nsh-core 0.6.1's `Dialog` has
/// no text field yet; elsewhere `components/Prompt.tsx` shows a glass card.
#[module]
pub struct TextPrompt;

#[module]
impl TextPrompt {
    /// Whether `ask` shows the system's alert here: iOS.
    pub fn available() -> bool {
        cfg!(target_os = "ios")
    }

    /// Shows the alert: `title`, a `message` under it (the last try's error,
    /// or ""), a field starting with `value` and showing `placeholder`, and
    /// Cancel and `confirm`, in `tint` (`#rrggbb`; "" for the system's).
    /// Resolves with JSON: `{ "text": "…" }` when confirmed, `null` when
    /// cancelled.
    pub async fn ask(
        title: String,
        message: String,
        value: String,
        placeholder: String,
        confirm: String,
        tint: String,
    ) -> String {
        #[cfg(target_os = "ios")]
        {
            let text = prompt::ask(prompt::Ask {
                title,
                message,
                value,
                placeholder,
                confirm,
                tint,
            })
            .await;
            match text {
                Some(text) => serde_json::json!({ "text": text }).to_string(),
                None => "null".to_owned(),
            }
        }
        #[cfg(not(target_os = "ios"))]
        {
            let _ = (title, message, value, placeholder, confirm, tint);
            "null".to_owned()
        }
    }
}

/// The system's menu (`UIMenu`) from a point in the window: what a long
/// press, a swipe's buttons and the reader's ••• open on iOS. UIKit draws it
/// as it draws a long press's menu (Liquid Glass on iOS 26), with symbols,
/// groups, submenus and destructive items, beside what was touched.
/// nsh's `AlertDialog` opens at the bottom of the screen, and iOS 26 squeezes
/// an action sheet with a source into a narrow popover.
#[module]
pub struct PopupMenu;

#[module]
impl PopupMenu {
    /// Whether `show` works here: iOS, while UIKit has the call it uses.
    pub fn available() -> bool {
        menu::available()
    }

    /// Shows `items` (JSON: `[{ id, title, subtitle?, symbol?, destructive?,
    /// checked? } | { title, subtitle?, symbol?, children, row? } | { separator: true }]`)
    /// under `title`, from `x`, `y` (points in the window). A negative `x`
    /// opens it from the navigation bar's right-hand button. Resolves with the chosen item's id, or "" when it
    /// was dismissed.
    pub async fn show(title: Option<String>, items: String, x: f64, y: f64) -> String {
        menu::show(title, items, x, y).await
    }
}

#[cfg(not(target_os = "ios"))]
mod menu {
    pub fn available() -> bool {
        false
    }

    pub async fn show(_title: Option<String>, _items: String, _x: f64, _y: f64) -> String {
        String::new()
    }
}

/// `UIMenu` from a clear button laid over the point for as long as the menu
/// shows, the menu being the button's own: UIKit draws a button's menu in
/// Liquid Glass (iOS 26), growing out of the button without dimming the
/// screen, where a long press's menu sits on a dimmed backdrop. UIKit has no
/// public call that opens a menu (a button's `performPrimaryAction` doesn't),
/// so the button's interaction is asked to, as a tap would; without that
/// call, nothing opens and `available` says so. The button sits in the view
/// of the controller on top, which presents the menu.
#[cfg(target_os = "ios")]
mod menu {
    use std::cell::RefCell;
    use std::ffi::CStr;
    use std::sync::OnceLock;
    use std::sync::mpsc::{Sender, channel};
    use std::time::Duration;

    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject, ClassBuilder, Sel};
    use objc2::{class, msg_send, sel};
    use objc2_foundation::{NSArray, NSPoint, NSRect, NSSize, NSString};
    use serde_json::Value;

    /// The call that opens an interaction's menu.
    fn present_sel() -> Sel {
        sel!(_presentMenuAtLocation:)
    }

    pub fn available() -> bool {
        // SAFETY: asking a class whether its instances answer a selector.
        unsafe {
            msg_send![class!(UIContextMenuInteraction), instancesRespondToSelector: present_sel()]
        }
    }

    pub async fn show(title: Option<String>, items: String, x: f64, y: f64) -> String {
        let Ok(Value::Array(items)) = serde_json::from_str::<Value>(&items) else {
            return String::new();
        };
        let (tx, rx) = channel::<String>();
        dispatch2::DispatchQueue::main().exec_async(move || {
            // SAFETY: on the main thread, with UIKit's own classes.
            unsafe { present(title, &items, NSPoint::new(x, y), tx) };
        });
        // The first word is the choice, or "" for a menu closed without one
        // (or one that never showed, which drops `tx`). UIKit may report the
        // close before it runs the chosen action, so a close waits a moment
        // for one.
        nsh_core::prelude::blocking(move || match rx.recv() {
            Ok(id) if !id.is_empty() => id,
            Ok(_) => rx
                .recv_timeout(Duration::from_millis(600))
                .unwrap_or_default(),
            Err(_) => String::new(),
        })
        .await
        .unwrap_or_default()
    }

    struct Open {
        /// The clear button the menu opens from.
        button: Retained<AnyObject>,
        tx: Sender<String>,
    }

    thread_local! {
        /// The menu on screen (one at a time).
        static OPEN: RefCell<Option<Open>> = const { RefCell::new(None) };
    }

    /// Takes the button away and answers "" (a choice, if any, was sent first).
    fn close() {
        close_if(|_| true);
    }

    /// `close`, if the menu on screen is the one from `button`: a menu ends
    /// a moment after it's gone (its animation), when the next may be open.
    fn close_from(button: usize) {
        close_if(|open| Retained::as_ptr(&open.button) as usize == button);
    }

    fn close_if(this_one: impl Fn(&Open) -> bool) {
        let taken = OPEN.with(|o| {
            let mut o = o.borrow_mut();
            if o.as_ref().is_some_and(this_one) { o.take() } else { None }
        });
        if let Some(open) = taken {
            let _ = open.tx.send(String::new());
            // SAFETY: on the main thread; the button is in a view or nowhere.
            unsafe {
                let _: () = msg_send![&*open.button, removeFromSuperview];
            }
        }
    }

    /// `contextMenuInteraction:willEndForConfiguration:animator:`, as UIButton
    /// has it, then `close` once the menu has gone.
    unsafe extern "C-unwind" fn will_end(
        this: &AnyObject,
        _cmd: Sel,
        interaction: *mut AnyObject,
        configuration: *mut AnyObject,
        animator: *mut AnyObject,
    ) {
        // SAFETY: UIButton's own method, with what UIKit passed.
        unsafe {
            let _: () = msg_send![
                super(this, class!(UIButton)),
                contextMenuInteraction: interaction,
                willEndForConfiguration: configuration,
                animator: animator
            ];
            // It lies over the bar's button until the menu has faded, and
            // would take the next tap there, opening this menu again only
            // for it to go with the button.
            let _: () = msg_send![this, setUserInteractionEnabled: false];
            let button = this as *const AnyObject as usize;
            if animator.is_null() {
                dispatch2::DispatchQueue::main().exec_async(move || close_from(button));
            } else {
                let done = RcBlock::new(move || {
                    dispatch2::DispatchQueue::main().exec_async(move || close_from(button))
                });
                let _: () = msg_send![animator, addCompletion: &*done];
            }
        }
    }

    /// UIButton, hearing its menu close.
    fn button_class() -> &'static AnyClass {
        static CLASS: OnceLock<usize> = OnceLock::new();
        let ptr = *CLASS.get_or_init(|| {
            let name: &CStr = c"LofuMenuButton";
            let cls = match ClassBuilder::new(name, class!(UIButton)) {
                Some(mut builder) => {
                    // SAFETY: the signature UIKit calls the selector with.
                    unsafe {
                        builder.add_method(
                            sel!(contextMenuInteraction:willEndForConfiguration:animator:),
                            will_end as unsafe extern "C-unwind" fn(_, _, _, _, _),
                        );
                    }
                    builder.register()
                }
                None => AnyClass::get(name).expect("LofuMenuButton"),
            };
            cls as *const AnyClass as usize
        });
        // SAFETY: a registered class lives as long as the process.
        unsafe { &*(ptr as *const AnyClass) }
    }

    fn text(value: &Value, key: &str) -> Option<Retained<NSString>> {
        value
            .get(key)?
            .as_str()
            .filter(|s| !s.is_empty())
            .map(NSString::from_str)
    }

    unsafe fn symbol(value: &Value) -> Option<Retained<AnyObject>> {
        let name = text(value, "symbol")?;
        unsafe { msg_send![class!(UIImage), systemImageNamed: &*name] }
    }

    /// Whether `value` is a row: its children drawn in place, side by side.
    fn is_row(value: &Value) -> bool {
        value.get("children").is_some() && value.get("row").and_then(Value::as_str).is_some()
    }

    /// One item: an action, or a submenu when it has `children` (drawn in
    /// place as a row of tiles when it has `row`: `"medium"` or `"small"`).
    unsafe fn element(value: &Value, tx: &Sender<String>) -> Option<Retained<AnyObject>> {
        unsafe {
            let image = symbol(value);
            if let Some(Value::Array(children)) = value.get("children") {
                let title = text(value, "title").unwrap_or_else(|| NSString::from_str(""));
                let row = value.get("row").and_then(Value::as_str);
                let children = group(children, tx);
                let menu: Retained<AnyObject> = msg_send![
                    class!(UIMenu),
                    menuWithTitle: &*title,
                    image: image.as_deref(),
                    identifier: Option::<&NSString>::None,
                    // UIMenuOptionsDisplayInline for a row.
                    options: if row.is_some() { 1usize } else { 0usize },
                    children: &*children
                ];
                // What it's set to now ("By name"), under its title.
                if let Some(subtitle) = text(value, "subtitle") {
                    let _: () = msg_send![&*menu, setSubtitle: &*subtitle];
                }
                // UIMenuElementSizeSmall / Medium (iOS 16); before that, a
                // plain group of the same items.
                if let Some(row) = row {
                    let responds: bool =
                        msg_send![&*menu, respondsToSelector: sel!(setPreferredElementSize:)];
                    if responds {
                        let size: isize = if row == "small" { 0 } else { 1 };
                        let _: () = msg_send![&*menu, setPreferredElementSize: size];
                    }
                }
                return Some(menu);
            }
            let title = text(value, "title")?;
            let id = value.get("id")?.as_str()?.to_owned();
            let tx = tx.clone();
            let handler = RcBlock::new(move |_: *mut AnyObject| {
                let _ = tx.send(id.clone());
            });
            let action: Retained<AnyObject> = msg_send![
                class!(UIAction),
                actionWithTitle: &*title,
                image: image.as_deref(),
                identifier: Option::<&NSString>::None,
                handler: &*handler
            ];
            if let Some(subtitle) = text(value, "subtitle") {
                let _: () = msg_send![&*action, setSubtitle: &*subtitle];
            }
            if value.get("destructive").and_then(Value::as_bool) == Some(true) {
                // UIMenuElementAttributesDestructive
                let _: () = msg_send![&*action, setAttributes: 2usize];
            }
            if value.get("checked").and_then(Value::as_bool) == Some(true) {
                // UIMenuElementStateOn
                let _: () = msg_send![&*action, setState: 1isize];
            }
            Some(action)
        }
    }

    /// `items` as menu elements: a separator ends a group, which UIKit draws
    /// apart from the next (an inline menu).
    unsafe fn group(items: &[Value], tx: &Sender<String>) -> Retained<NSArray<AnyObject>> {
        let is_separator = |v: &Value| v.get("separator").and_then(Value::as_bool) == Some(true);
        let groups: Vec<&[Value]> = items
            .split(is_separator)
            .filter(|g| !g.is_empty())
            .collect();
        // SAFETY: UIKit's own classes, on the main thread.
        let list = |g: &[Value]| -> Vec<Retained<AnyObject>> {
            g.iter().filter_map(|v| unsafe { element(v, tx) }).collect()
        };
        if groups.len() <= 1 {
            let one = groups.first().map(|g| list(g)).unwrap_or_default();
            return NSArray::from_retained_slice(&one);
        }
        let empty = NSString::from_str("");
        let inline: Vec<Retained<AnyObject>> = groups
            .iter()
            .filter_map(|g| {
                // A row is a group of its own already.
                if let [only] = g
                    && is_row(only)
                {
                    return unsafe { element(only, tx) };
                }
                let children = NSArray::from_retained_slice(&list(g));
                // UIMenuOptionsDisplayInline
                Some(unsafe {
                    msg_send![
                        class!(UIMenu),
                        menuWithTitle: &*empty,
                        image: Option::<&AnyObject>::None,
                        identifier: Option::<&NSString>::None,
                        options: 1usize,
                        children: &*children
                    ]
                })
            })
            .collect();
        NSArray::from_retained_slice(&inline)
    }

    /// The navigation bar showing in `window`, if any: the innermost one.
    unsafe fn navigation_bar(view: &AnyObject) -> Option<Retained<AnyObject>> {
        unsafe {
            let subviews: Retained<NSArray<AnyObject>> = msg_send![view, subviews];
            for v in subviews.to_vec().into_iter().rev() {
                let hidden: bool = msg_send![&*v, isHidden];
                if hidden {
                    continue;
                }
                if msg_send![&*v, isKindOfClass: class!(UINavigationBar)] {
                    return Some(v);
                }
                if let Some(bar) = navigation_bar(&v) {
                    return Some(bar);
                }
            }
            None
        }
    }

    /// Where a menu without a rect opens from: the navigation bar's
    /// right-hand button (a `headerRight`), else the window's middle.
    unsafe fn bar_button(window: &AnyObject) -> NSRect {
        unsafe {
            let bounds: NSRect = msg_send![window, bounds];
            let Some(bar) = navigation_bar(window) else {
                return NSRect::new(
                    NSPoint::new(bounds.size.width / 2.0, bounds.size.height / 2.0),
                    NSSize::new(1.0, 1.0),
                );
            };
            let b: NSRect = msg_send![&*bar, bounds];
            let r: NSRect = msg_send![&*bar, convertRect: b, toView: window];
            // A bar button: 44 points, 16 in from the edge.
            NSRect::new(
                NSPoint::new(r.origin.x + r.size.width - 16.0 - 44.0, r.origin.y),
                NSSize::new(44.0, r.size.height),
            )
        }
    }

    unsafe fn present(title: Option<String>, items: &[Value], at: NSPoint, tx: Sender<String>) {
        unsafe {
            // One menu at a time: one still up (it shouldn't be) answers "".
            close();
            let Some(window) = super::window::key() else {
                return;
            };
            let rect = if at.x < 0.0 || at.y < 0.0 {
                bar_button(&window)
            } else {
                NSRect::new(at, NSSize::new(1.0, 1.0))
            };
            let children = group(items, &tx);
            let title = NSString::from_str(title.as_deref().unwrap_or(""));
            let menu: Retained<AnyObject> = msg_send![
                class!(UIMenu),
                menuWithTitle: &*title,
                image: Option::<&AnyObject>::None,
                identifier: Option::<&NSString>::None,
                options: 0usize,
                children: &*children
            ];
            // In the view of the controller on top, which presents the menu
            // (a view in the window itself has no controller to present it).
            let host: Retained<AnyObject> = match super::window::top(&window) {
                Some(top) => msg_send![&*top, view],
                None => window.clone(),
            };
            let rect: NSRect = msg_send![&*host, convertRect: rect, fromView: &*window];
            let button: Retained<AnyObject> = msg_send![button_class(), buttonWithType: 0isize];
            let _: () = msg_send![&*button, setFrame: rect];
            let _: () = msg_send![&*button, setMenu: &*menu];
            let _: () = msg_send![&*button, setShowsMenuAsPrimaryAction: true];
            // UIContextMenuConfigurationElementOrderFixed: the order given,
            // whether it opens up or down.
            let _: () = msg_send![&*button, setPreferredMenuElementOrder: 2isize];
            let _: () = msg_send![&*button, setAccessibilityElementsHidden: true];
            let _: () = msg_send![&*host, addSubview: &*button];
            let interaction: Option<Retained<AnyObject>> =
                msg_send![&*button, contextMenuInteraction];
            let Some(interaction) = interaction.filter(|i| {
                let responds: bool = msg_send![&**i, respondsToSelector: present_sel()];
                responds
            }) else {
                let _: () = msg_send![&*button, removeFromSuperview];
                return;
            };
            OPEN.with(|o| {
                *o.borrow_mut() = Some(Open {
                    button: button.clone(),
                    tx,
                })
            });
            let b: NSRect = msg_send![&*button, bounds];
            let at = NSPoint::new(b.size.width / 2.0, b.size.height / 2.0);
            let _: () = msg_send![&*interaction, _presentMenuAtLocation: at];
        }
    }
}

/// The window and the controller UIKit presents over (iOS).
#[cfg(target_os = "ios")]
mod window {
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};
    use objc2_foundation::NSArray;

    /// The key window of the foreground scene, else any window.
    pub unsafe fn key() -> Option<Retained<AnyObject>> {
        unsafe {
            let app: Retained<AnyObject> = msg_send![class!(UIApplication), sharedApplication];
            let scenes: Retained<AnyObject> = msg_send![&*app, connectedScenes];
            let scenes: Retained<NSArray<AnyObject>> = msg_send![&*scenes, allObjects];
            let mut fallback = None;
            for scene in scenes.iter() {
                let is_window_scene: bool =
                    msg_send![&*scene, isKindOfClass: class!(UIWindowScene)];
                if !is_window_scene {
                    continue;
                }
                let windows: Retained<NSArray<AnyObject>> = msg_send![&*scene, windows];
                for w in windows.iter() {
                    let key: bool = msg_send![&*w, isKeyWindow];
                    if key {
                        return Some(w);
                    }
                    fallback.get_or_insert(w);
                }
            }
            fallback
        }
    }

    /// The controller on top of `window`'s: whatever is already up (a sheet, a dialog).
    pub unsafe fn top(window: &AnyObject) -> Option<Retained<AnyObject>> {
        unsafe {
            let root: Option<Retained<AnyObject>> = msg_send![window, rootViewController];
            let mut top = root?;
            loop {
                let next: Option<Retained<AnyObject>> = msg_send![&*top, presentedViewController];
                match next {
                    Some(n) => top = n,
                    None => return Some(top),
                }
            }
        }
    }
}
