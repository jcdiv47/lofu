//! What the app needs from the platform that nsh doesn't offer: the system's
//! share sheet (`UIActivityViewController` on iOS, `NSSharingServicePicker`
//! on macOS), the login the iOS share extension (`share/`) saves with, and
//! the system's own glass buttons (and, on iOS, search field) as native
//! components (`controls`, used through `components/native.tsx`). TSX
//! imports the modules from `lofu/native` (`lib/share.ts`); their TypeScript
//! declarations are generated into `.nsh/types/lofu/native.d.ts`.

use nsh_core::prelude::*;

#[cfg(any(target_os = "ios", target_os = "macos"))]
mod controls;

/// UIKit's controls (`controls::ios`), registered on every view.
#[cfg(target_os = "ios")]
#[native_components(ios)]
fn ios_components(components: &nsh_platform_ios::Components) {
    controls::ios::register(components);
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
    registry.module::<Share>();
    registry.module::<Sheet>();
    registry.module::<Controls>();
    registry.module::<ShareExtension>();
    registry.module::<files::Files>();
    registry.module::<files::Secrets>();
}

mod files;

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
}

/// An action sheet that opens from a point: nsh's `AlertDialog` opens at the
/// bottom of the screen, while iOS 26 draws a sheet with a source from it
/// (an iPad, as a popover there).
#[module]
pub struct Sheet;

#[module]
impl Sheet {
    /// Whether `show` works here: iOS.
    pub fn available() -> bool {
        cfg!(target_os = "ios")
    }

    /// Shows `labels` (each `"default"` or `"destructive"` by `roles`) under
    /// `title`, with a Cancel, from `x`, `y` (points in the window; negative
    /// for its middle). Resolves with the index of the label chosen, or -1
    /// when it was cancelled.
    pub async fn show(
        title: Option<String>,
        labels: Vec<String>,
        roles: Vec<String>,
        x: f64,
        y: f64,
    ) -> i32 {
        menu::actions(title, labels, roles, x, y).await
    }
}

/// The system's share sheet.
#[module]
pub struct Share;

#[module]
impl Share {
    /// Whether this platform has a share sheet (iOS and macOS).
    pub fn available() -> bool {
        cfg!(any(target_os = "ios", target_os = "macos"))
    }

    /// Opens the share sheet for a link. `x` and `y` (points from the
    /// window's top left; negative for its middle) are where it points from:
    /// the picker's anchor on macOS, the popover's on an iPad. Returns false
    /// where there is no share sheet; the sheet itself opens a moment later,
    /// on the main thread.
    pub fn url(url: String, x: f64, y: f64) -> bool {
        sheet::share(url, x, y)
    }
}

#[cfg(not(any(target_os = "ios", target_os = "macos")))]
mod sheet {
    pub fn share(_url: String, _x: f64, _y: f64) -> bool {
        false
    }
}

#[cfg(not(target_os = "ios"))]
mod menu {
    pub async fn actions(
        _title: Option<String>,
        _labels: Vec<String>,
        _roles: Vec<String>,
        _x: f64,
        _y: f64,
    ) -> i32 {
        -1
    }
}

#[cfg(target_os = "ios")]
mod menu {
    use std::sync::mpsc::{Sender, channel};

    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};
    use objc2_foundation::{NSPoint, NSRect, NSSize, NSString};

    pub async fn actions(
        title: Option<String>,
        labels: Vec<String>,
        roles: Vec<String>,
        x: f64,
        y: f64,
    ) -> i32 {
        let (tx, rx) = channel();
        dispatch2::DispatchQueue::main().exec_async(move || {
            // SAFETY: on the main thread, with UIKit's own classes.
            unsafe { present(title, &labels, &roles, x, y, tx) };
        });
        // Every way the sheet closes runs one of its actions (a tap outside
        // runs Cancel); one that never showed drops `tx`, and so -1.
        nsh_core::prelude::blocking(move || rx.recv().unwrap_or(-1))
            .await
            .unwrap_or(-1)
    }

    unsafe fn action(
        title: &str,
        style: isize,
        tx: &Sender<i32>,
        index: i32,
    ) -> Retained<AnyObject> {
        let tx = tx.clone();
        let handler = RcBlock::new(move |_: *mut AnyObject| {
            let _ = tx.send(index);
        });
        unsafe {
            msg_send![
                class!(UIAlertAction),
                actionWithTitle: &*NSString::from_str(title),
                style: style,
                handler: &*handler
            ]
        }
    }

    unsafe fn present(
        title: Option<String>,
        labels: &[String],
        roles: &[String],
        x: f64,
        y: f64,
        tx: Sender<i32>,
    ) {
        unsafe {
            let Some(window) = super::window::key() else {
                return;
            };
            let Some(top) = super::window::top(&window) else {
                return;
            };
            let title = title.as_deref().map(NSString::from_str);
            // UIAlertControllerStyleActionSheet
            let alert: Retained<AnyObject> = msg_send![
                class!(UIAlertController),
                alertControllerWithTitle: title.as_deref(),
                message: Option::<&NSString>::None,
                preferredStyle: 0isize
            ];
            for (i, label) in labels.iter().enumerate() {
                // UIAlertActionStyleDefault, UIAlertActionStyleDestructive
                let style = if roles.get(i).is_some_and(|r| r == "destructive") {
                    2
                } else {
                    0
                };
                let a = action(label, style, &tx, i as i32);
                let _: () = msg_send![&*alert, addAction: &*a];
            }
            // UIAlertActionStyleCancel: hidden in a popover, run by a tap outside it.
            let cancel = action("Cancel", 1, &tx, -1);
            let _: () = msg_send![&*alert, addAction: &*cancel];
            drop(tx);

            let popover: Option<Retained<AnyObject>> =
                msg_send![&*alert, popoverPresentationController];
            if let Some(popover) = popover {
                let bounds: NSRect = msg_send![&*window, bounds];
                let (px, py) = if x >= 0.0 && y >= 0.0 {
                    (x, y)
                } else {
                    (bounds.size.width / 2.0, bounds.size.height / 2.0)
                };
                let _: () = msg_send![&*popover, setSourceView: &*window];
                let _: () = msg_send![
                    &*popover,
                    setSourceRect: NSRect::new(NSPoint::new(px, py), NSSize::new(1.0, 1.0))
                ];
            }
            let _: () = msg_send![
                &*top,
                presentViewController: &*alert,
                animated: true,
                completion: Option::<&block2::Block<dyn Fn()>>::None
            ];
        }
    }
}

#[cfg(any(target_os = "ios", target_os = "macos"))]
mod sheet {
    use objc2::rc::{Allocated, Retained};
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};
    use objc2_foundation::{NSArray, NSString, NSURL};

    /// Modules run on nsh's engine thread; UIKit and AppKit only on the main one.
    pub fn share(url: String, x: f64, y: f64) -> bool {
        dispatch2::DispatchQueue::main().exec_async(move || {
            // SAFETY: on the main thread, with the platform's own classes.
            unsafe { present(&url, x, y) };
        });
        true
    }

    /// The link, or its text when it doesn't parse as a URL.
    fn items(url: &str) -> Retained<NSArray<AnyObject>> {
        let text = NSString::from_str(url);
        match NSURL::URLWithString(&text) {
            Some(u) => {
                NSArray::from_retained_slice(&[Retained::into_super(Retained::into_super(u))])
            }
            None => {
                NSArray::from_retained_slice(&[Retained::into_super(Retained::into_super(text))])
            }
        }
    }

    #[cfg(target_os = "ios")]
    unsafe fn present(url: &str, x: f64, y: f64) {
        use objc2_foundation::{NSPoint, NSRect, NSSize};
        unsafe {
            let Some(window) = super::window::key() else {
                return;
            };
            let Some(top) = super::window::top(&window) else {
                return;
            };
            let items = items(url);
            let sheet: Allocated<AnyObject> = msg_send![class!(UIActivityViewController), alloc];
            let sheet: Retained<AnyObject> = msg_send![
                sheet,
                initWithActivityItems: &*items,
                applicationActivities: Option::<&AnyObject>::None
            ];
            // An iPad shows it as a popover, which needs an anchor.
            let popover: Option<Retained<AnyObject>> =
                msg_send![&*sheet, popoverPresentationController];
            if let Some(popover) = popover {
                let view: Retained<AnyObject> = msg_send![&*top, view];
                let bounds: NSRect = msg_send![&*view, bounds];
                let (px, py) = if x >= 0.0 && y >= 0.0 {
                    (x, y)
                } else {
                    (bounds.size.width / 2.0, bounds.size.height / 2.0)
                };
                let _: () = msg_send![&*popover, setSourceView: &*view];
                let _: () = msg_send![
                    &*popover,
                    setSourceRect: NSRect::new(NSPoint::new(px, py), NSSize::new(1.0, 1.0))
                ];
            }
            let _: () = msg_send![
                &*top,
                presentViewController: &*sheet,
                animated: true,
                completion: Option::<&block2::Block<dyn Fn()>>::None
            ];
        }
    }

    #[cfg(target_os = "macos")]
    thread_local! {
        /// The picker on screen: AppKit doesn't keep it alive while it shows.
        static PICKER: std::cell::RefCell<Option<Retained<AnyObject>>> =
            const { std::cell::RefCell::new(None) };
    }

    #[cfg(target_os = "macos")]
    unsafe fn present(url: &str, x: f64, y: f64) {
        use objc2_foundation::{NSPoint, NSRect, NSSize};
        unsafe {
            let app: Retained<AnyObject> = msg_send![class!(NSApplication), sharedApplication];
            let window: Option<Retained<AnyObject>> = msg_send![&*app, keyWindow];
            let window = match window {
                Some(w) => w,
                None => {
                    let main: Option<Retained<AnyObject>> = msg_send![&*app, mainWindow];
                    let Some(w) = main else { return };
                    w
                }
            };
            let Some(view): Option<Retained<AnyObject>> = msg_send![&*window, contentView] else {
                return;
            };
            let bounds: NSRect = msg_send![&*view, bounds];
            let flipped: bool = msg_send![&*view, isFlipped];
            let (px, top) = if x >= 0.0 && y >= 0.0 {
                (x, y)
            } else {
                (bounds.size.width / 2.0, bounds.size.height / 2.0)
            };
            let py = if flipped {
                top
            } else {
                bounds.size.height - top
            };
            let items = items(url);
            let picker: Allocated<AnyObject> = msg_send![class!(NSSharingServicePicker), alloc];
            let picker: Retained<AnyObject> = msg_send![picker, initWithItems: &*items];
            // NSRectEdgeMinY: below the point in a flipped view, above it otherwise.
            let _: () = msg_send![
                &*picker,
                showRelativeToRect: NSRect::new(NSPoint::new(px, py), NSSize::new(1.0, 1.0)),
                ofView: &*view,
                preferredEdge: 1usize
            ];
            PICKER.with(|p| *p.borrow_mut() = Some(picker));
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
