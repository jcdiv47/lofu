//! An item of the app's in the system's edit menu over a read-only
//! `RichEditor` (iOS): the reader's *Highlight* beside Copy and Select All.
//!
//! nsh opens that menu itself (`Command::OpenEditMenu`) on the hidden text
//! view it keeps at the caret, with a `UIEditMenuInteraction` whose delegate
//! is the text view, and takes no items of the app's for a `RichEditor`.
//! The text views inside the editor's view are given a subclass of their own
//! (as KVO does: same instance size, one method more) that answers
//! `editMenuInteraction:menuForConfiguration:suggestedActions:` with the
//! app's item first, then what UIKit suggested. Other text views keep their
//! class, so their menus are untouched.
//!
//! A chosen item comes back as the editor's label through `next`, which the
//! app keeps awaiting (`lib/editMenu.ts`), as the toolbar's clicks do.

use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Mutex, OnceLock};

type Events = (Mutex<Sender<String>>, Mutex<Receiver<String>>);

fn events() -> &'static Events {
    static EVENTS: OnceLock<Events> = OnceLock::new();
    EVENTS.get_or_init(|| {
        let (tx, rx) = channel();
        (Mutex::new(tx), Mutex::new(rx))
    })
}

/// The label of the editor whose item was chosen; "" after a second
/// without one, so a JS context that's gone (a hot reload) stops waiting.
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

#[cfg(target_arch = "wasm32")]
pub async fn next() -> String {
    String::new()
}

#[cfg(not(target_os = "ios"))]
pub fn offer(_label: String, _title: String) {}

#[cfg(target_os = "ios")]
pub use ios::offer;

#[cfg(target_os = "ios")]
mod ios {
    use std::cell::RefCell;
    use std::collections::HashMap;
    use std::ffi::CString;

    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject, ClassBuilder, Sel};
    use objc2::{class, msg_send, sel};
    use objc2_foundation::{NSArray, NSString};

    use super::events;

    thread_local! {
        /// Editor label → the title of its item.
        static OFFERS: RefCell<HashMap<String, String>> = RefCell::new(HashMap::new());
        /// The subclass made for each text view class → that class.
        static MADE: RefCell<HashMap<usize, usize>> = RefCell::new(HashMap::new());
    }

    /// Offers an item titled `title` in the edit menu of the editor
    /// labelled `label` (its `accessibilityLabel`). Again for the same
    /// views does nothing; call it after the editor mounts and when it
    /// takes the focus, should nsh have made its text view again.
    pub fn offer(label: String, title: String) {
        dispatch2::DispatchQueue::main().exec_async(move || {
            OFFERS.with(|o| o.borrow_mut().insert(label.clone(), title));
            // SAFETY: on the main thread, with UIKit's own classes.
            unsafe {
                if let Some(window) = crate::window::key() {
                    walk(&window, &label, false);
                }
            }
        });
    }

    unsafe fn walk(view: &AnyObject, label: &str, inside: bool) {
        unsafe {
            let own: Option<Retained<NSString>> = msg_send![view, accessibilityLabel];
            let inside = inside || own.is_some_and(|l| l.to_string() == label);
            if inside && msg_send![view, isKindOfClass: class!(UITextView)] {
                adopt(view);
            }
            let subviews: Retained<NSArray<AnyObject>> = msg_send![view, subviews];
            for v in subviews.iter() {
                walk(&v, label, inside);
            }
        }
    }

    /// The class of ours `class` is, or is a subclass of (KVO may have
    /// subclassed it again), and the class it was made from.
    fn ours(mut class: Option<&AnyClass>) -> Option<(usize, &'static AnyClass)> {
        while let Some(c) = class {
            let key = c as *const AnyClass as usize;
            if let Some(base) = MADE.with(|m| m.borrow().get(&key).copied()) {
                // SAFETY: a registered class lives as long as the process.
                return Some((key, unsafe { &*(base as *const AnyClass) }));
            }
            class = c.superclass();
        }
        None
    }

    unsafe fn adopt(view: &AnyObject) {
        let class = view.class();
        if ours(Some(class)).is_some() {
            return;
        }
        let Some(sub) = subclass(class) else { return };
        // SAFETY: `sub` adds a method and no ivars to the view's own class,
        // so the instance fits it (what KVO does).
        unsafe {
            objc2::ffi::object_setClass(
                view as *const AnyObject as *mut AnyObject,
                sub as *const AnyClass,
            );
        }
    }

    fn subclass(base: &AnyClass) -> Option<&'static AnyClass> {
        let name = CString::new(format!("LofuEditMenu_{}", base.name().to_string_lossy())).ok()?;
        let made = match ClassBuilder::new(&name, base) {
            Some(mut builder) => {
                // SAFETY: the signature UIKit calls the delegate method with.
                unsafe {
                    builder.add_method(
                        sel!(editMenuInteraction:menuForConfiguration:suggestedActions:),
                        menu_for as unsafe extern "C-unwind" fn(_, _, _, _, _) -> _,
                    );
                }
                builder.register()
            }
            None => AnyClass::get(&name)?,
        };
        MADE.with(|m| {
            m.borrow_mut()
                .insert(made as *const AnyClass as usize, base as *const AnyClass as usize)
        });
        Some(made)
    }

    /// The label of the editor `view` is in that has an item offered, and the item's title.
    unsafe fn offered(view: &AnyObject) -> Option<(String, String)> {
        unsafe {
            let mut at: Option<Retained<AnyObject>> = Some(Retained::retain(
                view as *const AnyObject as *mut AnyObject,
            )?);
            while let Some(v) = at {
                let own: Option<Retained<NSString>> = msg_send![&*v, accessibilityLabel];
                if let Some(label) = own.map(|l| l.to_string())
                    && let Some(title) = OFFERS.with(|o| o.borrow().get(&label).cloned())
                {
                    return Some((label, title));
                }
                at = msg_send![&*v, superview];
            }
            None
        }
    }

    /// `UIEditMenuInteractionDelegate`'s menu: the app's item, then the
    /// menu the class it was made from gives (or what UIKit suggested).
    unsafe extern "C-unwind" fn menu_for(
        this: &AnyObject,
        _cmd: Sel,
        interaction: *mut AnyObject,
        configuration: *mut AnyObject,
        suggested: *mut AnyObject,
    ) -> *mut AnyObject {
        // SAFETY: UIKit's own classes, on the main thread, with what UIKit passed.
        unsafe {
            let base = ours(Some(this.class())).map(|(_, base)| base);
            let theirs: Option<Retained<AnyObject>> = match base {
                Some(base)
                    if msg_send![base, instancesRespondToSelector: sel!(editMenuInteraction:menuForConfiguration:suggestedActions:)] =>
                {
                    let menu: Option<Retained<AnyObject>> = msg_send![
                        super(this, base),
                        editMenuInteraction: interaction,
                        menuForConfiguration: configuration,
                        suggestedActions: suggested
                    ];
                    menu.map(|m| msg_send![&*m, children])
                }
                _ => Retained::retain(suggested),
            };
            let mut children: Vec<Retained<AnyObject>> = theirs
                .map(|a| {
                    let a: Retained<NSArray<AnyObject>> = Retained::cast_unchecked(a);
                    a.to_vec()
                })
                .unwrap_or_default();
            // Only over a selection: nsh's text view offers Copy for what
            // the editor asked (a caret gets Select All alone).
            let selected: bool = msg_send![
                this,
                canPerformAction: sel!(copy:),
                withSender: Option::<&AnyObject>::None
            ];
            if selected && let Some((label, title)) = offered(this) {
                let handler = RcBlock::new(move |_: *mut AnyObject| {
                    let tx = events().0.lock().unwrap_or_else(|e| e.into_inner());
                    let _ = tx.send(label.clone());
                });
                let action: Retained<AnyObject> = msg_send![
                    class!(UIAction),
                    actionWithTitle: &*NSString::from_str(&title),
                    image: Option::<&AnyObject>::None,
                    identifier: Option::<&NSString>::None,
                    handler: &*handler
                ];
                children.insert(0, action);
            }
            let children = NSArray::from_retained_slice(&children);
            let menu: Retained<AnyObject> =
                msg_send![class!(UIMenu), menuWithChildren: &*children];
            Retained::autorelease_return(menu)
        }
    }
}
