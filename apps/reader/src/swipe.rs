//! Swiping back on macOS: two fingers to the right on the trackpad, as in
//! Finder and Safari. nsh hands the window's scrolls to its own scroll views
//! and has no gesture for this, so an AppKit local monitor watches the scroll
//! events on their way to nsh (it only looks: nsh gets every one), and a
//! gesture that went right, and much more right than up or down, is a swipe
//! back once the fingers lift. The app pops its page (`lib/swipe.ts`).
//!
//! It follows the system's setting (Trackpad › More Gestures › Swipe between
//! pages, `isSwipeTrackingFromScrollEventsEnabled`) and its scroll direction,
//! as AppKit's own swipes do. A web view that can go back has its own swipe
//! (`allowsBackForwardNavigationGestures`, `screens/Browser.tsx`), which is
//! left to it; once it can't, the swipe closes the page.
//!
//! Swipes come to the app one at a time through `next`, which it keeps
//! awaiting, as the toolbar's events do (`src/toolbar.rs`).

use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Mutex, OnceLock};

/// Where the monitor sends its swipes, and where `next` takes them from.
type Events = (Mutex<Sender<()>>, Mutex<Receiver<()>>);

fn events() -> &'static Events {
    static EVENTS: OnceLock<Events> = OnceLock::new();
    EVENTS.get_or_init(|| {
        let (tx, rx) = channel();
        (Mutex::new(tx), Mutex::new(rx))
    })
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn emit() {
    let tx = events().0.lock().unwrap_or_else(|e| e.into_inner());
    let _ = tx.send(());
}

/// Whether the next swipe back came: true when it did, false after a second
/// without one (the app asks again at once; the timeout lets a JS context
/// that's gone, a hot reload, stop waiting). The first call starts watching.
#[cfg(target_os = "macos")]
pub async fn next() -> bool {
    mac::watch();
    nsh_core::prelude::blocking(|| {
        let rx = events().1.lock().unwrap_or_else(|e| e.into_inner());
        rx.recv_timeout(std::time::Duration::from_secs(1)).is_ok()
    })
    .await
    .unwrap_or(false)
}

/// No trackpad swipes here (`available()` is false, so the app never asks).
#[cfg(not(target_os = "macos"))]
pub async fn next() -> bool {
    false
}

#[cfg(target_os = "macos")]
mod mac {
    use std::cell::Cell;
    use std::sync::Once;

    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject, Bool};
    use objc2::{class, msg_send};
    use objc2_foundation::NSPoint;

    /// How far right the fingers have to have moved, in points, for a swipe.
    const DISTANCE: f64 = 50.0;
    /// How many times more it has to have moved sideways than up or down.
    const RATIO: f64 = 2.0;

    /// `NSEventMaskScrollWheel` (`1 << NSEventTypeScrollWheel`).
    const SCROLL_MASK: u64 = 1 << 22;
    // `NSEventPhase`.
    const BEGAN: usize = 1 << 0;
    const CHANGED: usize = 1 << 2;
    const ENDED: usize = 1 << 3;
    const CANCELLED: usize = 1 << 4;

    thread_local! {
        /// How far the fingers moved sideways (right is positive) and up or
        /// down in the gesture going on, while it may be a swipe.
        static MOVED: Cell<Option<(f64, f64)>> = const { Cell::new(None) };
    }

    /// Starts watching the window's scrolls, once.
    pub fn watch() {
        static WATCHING: Once = Once::new();
        WATCHING.call_once(|| {
            dispatch2::DispatchQueue::main().exec_async(|| {
                let handler = RcBlock::new(|event: *mut AnyObject| -> *mut AnyObject {
                    // SAFETY: AppKit hands the monitor an NSEvent, on the main thread.
                    if let Some(e) = unsafe { event.as_ref() } {
                        unsafe { scrolled(e) };
                    }
                    event
                });
                // SAFETY: AppKit's own method; the monitor lives as long as
                // the app, so the token it returns is kept forever.
                let monitor: Option<Retained<AnyObject>> = unsafe {
                    msg_send![
                        class!(NSEvent),
                        addLocalMonitorForEventsMatchingMask: SCROLL_MASK,
                        handler: &*handler
                    ]
                };
                std::mem::forget(monitor);
            });
        });
    }

    /// Follows a trackpad gesture: its phases (fingers down, moving, up),
    /// not its momentum, which comes after the fingers lift.
    ///
    /// # Safety
    /// `event` is a scroll NSEvent, on the main thread.
    unsafe fn scrolled(event: &AnyObject) {
        let precise: bool = unsafe { msg_send![event, hasPreciseScrollingDeltas] };
        let momentum: usize = unsafe { msg_send![event, momentumPhase] };
        if !precise || momentum != 0 {
            return;
        }
        let phase: usize = unsafe { msg_send![event, phase] };
        // The fingers' way: natural scrolling moves the content with them,
        // and the deltas are the content's.
        let natural: bool = unsafe { msg_send![event, isDirectionInvertedFromDevice] };
        let sign = if natural { 1.0 } else { -1.0 };
        let dx: f64 = unsafe { msg_send![event, scrollingDeltaX] };
        let dx = sign * dx;
        let dy: f64 = unsafe { msg_send![event, scrollingDeltaY] };
        if phase & BEGAN != 0 {
            let on = unsafe { swipes_here(event) };
            MOVED.set(on.then_some((dx, dy)));
        } else if phase & CHANGED != 0 {
            if let Some((x, y)) = MOVED.get() {
                MOVED.set(Some((x + dx, y + dy)));
            }
        } else if phase & ENDED != 0 {
            if let Some((x, y)) = MOVED.take()
                && x >= DISTANCE
                && x >= RATIO * y.abs()
            {
                super::emit();
            }
        } else if phase & CANCELLED != 0 {
            MOVED.set(None);
        }
    }

    /// Whether a gesture starting with `event` may be a swipe back: the
    /// system's setting allows it, and it isn't over a web view that can go
    /// back, which swipes itself.
    ///
    /// # Safety
    /// `event` is an NSEvent, on the main thread.
    unsafe fn swipes_here(event: &AnyObject) -> bool {
        let enabled: bool =
            unsafe { msg_send![class!(NSEvent), isSwipeTrackingFromScrollEventsEnabled] };
        if !enabled {
            return false;
        }
        let window: Option<Retained<AnyObject>> = unsafe { msg_send![event, window] };
        let Some(window) = window else {
            return false;
        };
        let content: Option<Retained<AnyObject>> = unsafe { msg_send![&*window, contentView] };
        let Some(content) = content else {
            return true;
        };
        // `hitTest:` takes a point in the view's superview.
        let frame_view: Option<Retained<AnyObject>> = unsafe { msg_send![&*content, superview] };
        let at: NSPoint = unsafe { msg_send![event, locationInWindow] };
        let at: NSPoint = match &frame_view {
            Some(v) => unsafe {
                msg_send![&**v, convertPoint: at, fromView: std::ptr::null::<AnyObject>()]
            },
            None => at,
        };
        let hit: Option<Retained<AnyObject>> = unsafe { msg_send![&*content, hitTest: at] };
        let Some(web) = AnyClass::get(c"WKWebView") else {
            return true;
        };
        let mut view = hit;
        while let Some(v) = view {
            let is_web: Bool = unsafe { msg_send![&*v, isKindOfClass: web] };
            if is_web.as_bool() {
                let back: bool = unsafe { msg_send![&*v, canGoBack] };
                return !back;
            }
            view = unsafe { msg_send![&*v, superview] };
        }
        true
    }
}
