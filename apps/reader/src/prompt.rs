//! Asks for a line of text with the system's alert (iOS): a
//! `UIAlertController` with a text field, which iOS 26 draws in Liquid
//! Glass, over a dimmed page, with the keyboard up. nsh's `AlertDialog`
//! takes no text, so `components/Prompt.tsx` used a card of its own.

use std::sync::mpsc::{Sender, channel};

use block2::RcBlock;
use objc2::rc::{Retained, Weak};
use objc2::runtime::AnyObject;
use objc2::{class, msg_send};
use objc2_foundation::{NSArray, NSString};

/// What `ask` asks: the alert's title, a message under it (an error from the
/// last try), the text it starts with, the field's placeholder and the
/// button that confirms.
pub struct Ask {
    pub title: String,
    pub message: String,
    pub value: String,
    pub placeholder: String,
    pub confirm: String,
    /// The buttons' color (`#rrggbb`), or "" for the system's.
    pub tint: String,
}

/// The text confirmed, or `None` when cancelled (or nothing could show it).
pub async fn ask(ask: Ask) -> Option<String> {
    let (tx, rx) = channel::<Option<String>>();
    dispatch2::DispatchQueue::main().exec_async(move || {
        // SAFETY: on the main thread, with UIKit's own classes.
        unsafe { present(ask, tx) };
    });
    nsh_core::prelude::blocking(move || rx.recv().ok().flatten())
        .await
        .ok()
        .flatten()
}

fn ns(s: &str) -> Option<Retained<NSString>> {
    (!s.is_empty()).then(|| NSString::from_str(s))
}

unsafe fn present(ask: Ask, tx: Sender<Option<String>>) {
    unsafe {
        let Some(window) = crate::window::key() else {
            return;
        };
        let Some(top) = crate::window::top(&window) else {
            return;
        };
        // Asked again right after a confirm that failed: the last alert may
        // still be going away, and nothing can present until it has gone.
        let leaving: bool = msg_send![&*top, isBeingDismissed];
        let coordinator: Option<Retained<AnyObject>> = msg_send![&*top, transitionCoordinator];
        if leaving && let Some(coordinator) = coordinator {
            let pending = std::cell::RefCell::new(Some((ask, tx)));
            let done = RcBlock::new(move |_: *mut AnyObject| {
                if let Some((ask, tx)) = pending.borrow_mut().take() {
                    // UIKit calls the completion on the main thread.
                    present(ask, tx);
                }
            });
            let _: bool = msg_send![
                &*coordinator,
                animateAlongsideTransition: Option::<&block2::Block<dyn Fn(*mut AnyObject)>>::None,
                completion: &*done
            ];
            return;
        }
        let title = ns(&ask.title);
        let message = ns(&ask.message);
        // UIAlertControllerStyleAlert
        let alert: Retained<AnyObject> = msg_send![
            class!(UIAlertController),
            alertControllerWithTitle: title.as_deref(),
            message: message.as_deref(),
            preferredStyle: 1isize
        ];

        // The app's accent on the buttons, as its other controls have it.
        if let Some(c) = crate::controls::parse_color(Some(&serde_json::Value::from(ask.tint.as_str()))) {
            let tint: Retained<AnyObject> = msg_send![
                class!(UIColor),
                colorWithRed: c[0],
                green: c[1],
                blue: c[2],
                alpha: c[3]
            ];
            let view: Retained<AnyObject> = msg_send![&*alert, view];
            let _: () = msg_send![&*view, setTintColor: &*tint];
        }

        let value = NSString::from_str(&ask.value);
        let placeholder = NSString::from_str(&ask.placeholder);
        let configure = RcBlock::new(move |field: *mut AnyObject| {
            // UIKit passes the field it made, on the main thread.
            let _: () = msg_send![field, setText: &*value];
            let _: () = msg_send![field, setPlaceholder: &*placeholder];
            let _: () = msg_send![field, setClearButtonMode: 1isize]; // while editing
            let _: () = msg_send![field, setAutocorrectionType: 1isize]; // no
            let _: () = msg_send![field, setReturnKeyType: 9isize]; // done
        });
        let _: () = msg_send![&*alert, addTextFieldWithConfigurationHandler: &*configure];

        let cancel_tx = tx.clone();
        let cancel = RcBlock::new(move |_: *mut AnyObject| {
            let _ = cancel_tx.send(None);
        });
        // UIAlertActionStyleCancel
        let cancel: Retained<AnyObject> = msg_send![
            class!(UIAlertAction),
            actionWithTitle: &*NSString::from_str("Cancel"),
            style: 1isize,
            handler: &*cancel
        ];
        let _: () = msg_send![&*alert, addAction: &*cancel];

        let weak = Weak::from_retained(&alert);
        let confirm = RcBlock::new(move |_: *mut AnyObject| {
            // The alert's own field, on the main thread.
            let text = weak.load().and_then(|alert| {
                let fields: Option<Retained<NSArray<AnyObject>>> = msg_send![&*alert, textFields];
                let field = fields?.firstObject()?;
                let text: Option<Retained<NSString>> = msg_send![&*field, text];
                text.map(|t| t.to_string())
            });
            let _ = tx.send(Some(text.unwrap_or_default()));
        });
        let confirm: Retained<AnyObject> = msg_send![
            class!(UIAlertAction),
            actionWithTitle: &*NSString::from_str(&ask.confirm),
            style: 0isize,
            handler: &*confirm
        ];
        let _: () = msg_send![&*alert, addAction: &*confirm];
        // Return confirms, and the button is drawn as the one that does.
        let _: () = msg_send![&*alert, setPreferredAction: &*confirm];

        let _: () = msg_send![
            &*top,
            presentViewController: &*alert,
            animated: true,
            completion: Option::<&block2::Block<dyn Fn()>>::None
        ];
    }
}
