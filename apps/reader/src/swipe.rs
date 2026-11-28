//! Swiping back on macOS: two fingers to the right on the trackpad, as in
//! Safari. The page follows the fingers and slides off to the right over the
//! one under it; letting go far enough (or with a flick) goes back, and
//! going back the other way, or letting go too soon, puts it back.
//!
//! nsh's stack on the Mac has no gesture of its own (its pop doesn't follow
//! a finger), and it keeps the window's scrolls for its scroll views. So an
//! AppKit local monitor sees the scroll events before nsh does. When a
//! gesture starts, the monitor holds its first events back until it can
//! tell the gesture's way: sideways to the right hands it to AppKit's own
//! swipe tracking (`trackSwipeEventWithOptions:…`, Safari's, which tells
//! how far the fingers went and, as they let go, which way it ends), and
//! nsh never sees it; anything else is
//! handed on to nsh as it came, so lists scroll as before.
//!
//! The pages are nsh's own views: the stack is the view named `pages`
//! (the `NavStack`'s `testID`), whose screens are its subviews, the top one
//! shown and the ones under it hidden. While the fingers move, the module
//! shows the one under the top and slides the two by their layers'
//! transforms, as nsh's own pop does (the page under it starts 30% of the
//! way to the left). Once the swipe went back, the top page is off to the
//! right; the app pops it (`next` → `lib/swipe.ts`), with no animation of
//! nsh's, which puts the views as nsh wants them.
//!
//! It follows the system's setting (Trackpad › More Gestures › Swipe between
//! pages, `isSwipeTrackingFromScrollEventsEnabled`) and its scroll
//! direction, as AppKit's own swipes do. A web view that can go back has its
//! own swipe (`allowsBackForwardNavigationGestures`, `screens/Browser.tsx`),
//! which is left to it; once it can't, the swipe closes the page. The app
//! says when there's somewhere to go back to (`enable`).
//!
//! Switching away mid-swipe (⌘-Tab with the fingers still down) sends the
//! rest of the gesture to another app, and AppKit's tracking never hears it
//! end: the page would stay where the fingers left it, the one under it
//! showing and the stack not popped (the toolbar's Back left over the
//! library). So when the app stops being active, a swipe still going is
//! settled at once (`abandon`): back if it had already gone back, put back
//! otherwise, and whatever AppKit's tracking says of it afterwards is
//! ignored and the tracking stopped.
//!
//! Once the fingers let go, AppKit's own spring would run as long as the
//! trackpad's momentum does, most of a second, and only then say the swipe
//! is complete (the stack popped, and the toolbar's Back gone, that late).
//! So the tracking stops as the fingers let go, the rest of the momentum is
//! dropped, and the pages glide to the end AppKit chose with Core Animation
//! (`glide`: `GLIDE` seconds for the whole width, less for what's left),
//! the swipe settling as they get there.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Mutex, OnceLock};

/// Where the swipes that went back are sent, and where `next` takes them from.
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

/// Whether the app has a page to go back to and nothing in the way (a dialog).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
static ENABLED: AtomicBool = AtomicBool::new(false);

/// Whether a swipe may go back now. The first call starts watching.
pub fn enable(on: bool) {
    ENABLED.store(on, Ordering::Relaxed);
    #[cfg(target_os = "macos")]
    mac::watch();
}

/// Whether a swipe went back: true when one did, false after a second
/// without one (the app asks again at once; the timeout lets a JS context
/// that's gone, a hot reload, stop waiting).
#[cfg(target_os = "macos")]
pub async fn next() -> bool {
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
    use std::cell::{Cell, RefCell};
    use std::rc::Rc;
    use std::sync::Once;
    use std::sync::atomic::Ordering;

    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject, Bool};
    use objc2::{Encode, Encoding, Message, class, msg_send};
    use objc2_foundation::{NSPoint, NSRect, NSString};

    /// The `NavStack`'s `testID`: its view's accessibility identifier.
    const STACK_ID: &str = "pages";
    /// How far left the page under the top one starts, of the stack's width
    /// (nsh's `PARALLAX`).
    const PARALLAX: f64 = 0.3;
    /// Seconds the pages take to glide the stack's whole width once the
    /// fingers let go (less for what's left of it), and the least.
    const GLIDE: f64 = 0.25;
    const GLIDE_MIN: f64 = 0.08;

    /// `NSEventMaskScrollWheel` (`1 << NSEventTypeScrollWheel`).
    const SCROLL_MASK: u64 = 1 << 22;
    // `NSEventPhase`.
    const BEGAN: usize = 1 << 0;
    const CHANGED: usize = 1 << 2;
    const ENDED: usize = 1 << 3;
    const CANCELLED: usize = 1 << 4;
    const MAY_BEGIN: usize = 1 << 5;
    // `NSEventSwipeTrackingOptions`.
    const LOCK_DIRECTION: usize = 1 << 0;
    const CLAMP_AMOUNT: usize = 1 << 1;

    /// Core Graphics' affine transform, for `CALayer.affineTransform`.
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct CGAffineTransform {
        a: f64,
        b: f64,
        c: f64,
        d: f64,
        tx: f64,
        ty: f64,
    }

    // SAFETY: the same fields as Core Graphics' struct, in its order.
    unsafe impl Encode for CGAffineTransform {
        const ENCODING: Encoding = Encoding::Struct(
            "CGAffineTransform",
            &[
                f64::ENCODING,
                f64::ENCODING,
                f64::ENCODING,
                f64::ENCODING,
                f64::ENCODING,
                f64::ENCODING,
            ],
        );
    }

    fn moved_by(x: f64) -> CGAffineTransform {
        CGAffineTransform {
            a: 1.0,
            b: 0.0,
            c: 0.0,
            d: 1.0,
            tx: x,
            ty: 0.0,
        }
    }

    /// What the monitor does with the gesture going on.
    enum Gesture {
        /// None, or one that's nsh's: events go to it.
        Idle,
        /// Just started and may be a swipe: its events so far, held back
        /// until its way is known.
        Held(Vec<Retained<AnyObject>>),
        /// AppKit is tracking it as a swipe; nsh never hears of it.
        Swiping,
        /// A swipe settled before its momentum ran out (`track`): the rest
        /// of that momentum is dropped, not scrolled.
        Draining,
    }

    /// The pages a swipe moves: the stack, its top page and the one under it.
    struct Pages {
        stack: Retained<AnyObject>,
        top: Retained<AnyObject>,
        below: Retained<AnyObject>,
    }

    /// A swipe AppKit is tracking.
    struct Swipe {
        pages: Rc<Pages>,
        /// Whether its fingers let go going back (it springs off to the right).
        went_back: Cell<bool>,
        /// Let go (gliding to its end) or settled by `abandon`: the tracking's
        /// calls after are ignored, and the next one stops it.
        done: Cell<bool>,
    }

    thread_local! {
        static GESTURE: RefCell<Gesture> = const { RefCell::new(Gesture::Idle) };
        /// The swipe being tracked, until it's settled.
        static SWIPE: RefCell<Option<Rc<Swipe>>> = const { RefCell::new(None) };
        /// Set while held events are handed back to the window, which may
        /// pass them through the monitor again.
        static REPLAYING: Cell<bool> = const { Cell::new(false) };
    }

    /// Starts watching the window's scrolls, once.
    pub fn watch() {
        static WATCHING: Once = Once::new();
        WATCHING.call_once(|| {
            dispatch2::DispatchQueue::main().exec_async(|| {
                let handler = RcBlock::new(|event: *mut AnyObject| -> *mut AnyObject {
                    // SAFETY: AppKit hands the monitor an NSEvent, on the main thread.
                    match unsafe { event.as_ref() } {
                        Some(e) if unsafe { take(e) } => std::ptr::null_mut(),
                        _ => event,
                    }
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
                // ⌘-Tab mid-swipe: the rest of the gesture goes elsewhere.
                let resigned = RcBlock::new(|_note: *mut AnyObject| {
                    // SAFETY: posted on the main queue, as asked.
                    unsafe { abandon() };
                });
                // SAFETY: AppKit's own methods; the observer lives as long as
                // the app, so its token is kept forever.
                let observer: Option<Retained<AnyObject>> = unsafe {
                    let center: Retained<AnyObject> =
                        msg_send![class!(NSNotificationCenter), defaultCenter];
                    let main: Retained<AnyObject> = msg_send![class!(NSOperationQueue), mainQueue];
                    msg_send![
                        &*center,
                        addObserverForName: &*NSString::from_str("NSApplicationDidResignActiveNotification"),
                        object: std::ptr::null::<AnyObject>(),
                        queue: &*main,
                        usingBlock: &*resigned
                    ]
                };
                std::mem::forget(observer);
            });
        });
    }

    /// The app stopped being active: a gesture going on won't be heard to
    /// end. Events held back are dropped (nsh never saw the gesture start),
    /// and a swipe is settled where it is: back if it went back, else put
    /// back.
    ///
    /// # Safety
    /// On the main thread.
    unsafe fn abandon() {
        GESTURE.with_borrow_mut(|g| *g = Gesture::Idle);
        unsafe { settle_swipe() };
    }

    /// Settles the swipe being tracked, if there is one, where it is: back
    /// if it went back, else put back. Whether there was one.
    ///
    /// # Safety
    /// On the main thread.
    unsafe fn settle_swipe() -> bool {
        let Some(swipe) = SWIPE.with_borrow(Option::clone) else {
            return false;
        };
        // Gliding to its end already: it settles as the glide ends.
        if !swipe.done.replace(true) {
            SWIPE.set(None);
            unsafe {
                if swipe.went_back.get() {
                    place(&swipe.pages, 1.0);
                    finish(swipe.pages.clone());
                } else {
                    put_back(&swipe.pages);
                }
            }
        }
        true
    }

    /// Whether the monitor keeps `event` from nsh: it's held back, or part
    /// of a swipe.
    ///
    /// # Safety
    /// `event` is a scroll NSEvent, on the main thread.
    unsafe fn take(event: &AnyObject) -> bool {
        if REPLAYING.get() {
            return false;
        }
        let precise: bool = unsafe { msg_send![event, hasPreciseScrollingDeltas] };
        let momentum: usize = unsafe { msg_send![event, momentumPhase] };
        let phase: usize = unsafe { msg_send![event, phase] };
        // What to do once the state is put down: AppKit's tracking and nsh
        // may call back into the monitor.
        let mut then = Then::Nothing;
        let take = GESTURE.with_borrow_mut(|gesture| match gesture {
            Gesture::Draining if momentum != 0 => true,
            Gesture::Draining => {
                // Something new: as with nothing going on.
                *gesture = Gesture::Idle;
                let starts = precise && phase & (BEGAN | MAY_BEGIN) != 0;
                if starts && unsafe { may_swipe(event) } {
                    *gesture = Gesture::Held(vec![event.retain()]);
                    true
                } else {
                    false
                }
            }
            Gesture::Swiping => {
                // AppKit's tracking takes the rest of the gesture; a new one
                // while the page settles is nsh's.
                if phase & (BEGAN | MAY_BEGIN) != 0 {
                    *gesture = Gesture::Idle;
                    false
                } else {
                    momentum == 0 && phase != 0
                }
            }
            Gesture::Idle => {
                let starts = precise && momentum == 0 && phase & (BEGAN | MAY_BEGIN) != 0;
                if starts && unsafe { may_swipe(event) } {
                    *gesture = Gesture::Held(vec![event.retain()]);
                    true
                } else {
                    false
                }
            }
            Gesture::Held(held) => {
                let dx: f64 = unsafe { msg_send![event, scrollingDeltaX] };
                let dy: f64 = unsafe { msg_send![event, scrollingDeltaY] };
                // The fingers' way: natural scrolling moves the content with
                // them, and the deltas are the content's.
                let natural: bool = unsafe { msg_send![event, isDirectionInvertedFromDevice] };
                let right = if natural { dx } else { -dx };
                let ends = phase & (ENDED | CANCELLED) != 0 || momentum != 0;
                if !ends && phase & (BEGAN | MAY_BEGIN | CHANGED) != 0 && dx == 0.0 && dy == 0.0 {
                    // No way yet.
                    held.push(event.retain());
                    return true;
                }
                if !ends
                    && right > 0.0
                    && dx.abs() > dy.abs()
                    && let Some(pages) = unsafe { pages(event) }
                {
                    *gesture = Gesture::Swiping;
                    then = Then::Track(pages);
                    return true;
                }
                // nsh's: it gets what was held, then this one.
                then = Then::Replay(std::mem::take(held));
                *gesture = Gesture::Idle;
                false
            }
        });
        match then {
            Then::Nothing => {}
            Then::Track(pages) => unsafe { track(event, pages) },
            Then::Replay(held) => unsafe { replay(held) },
        }
        take
    }

    /// What the monitor does after deciding on an event.
    enum Then {
        Nothing,
        Track(Pages),
        Replay(Vec<Retained<AnyObject>>),
    }

    /// Hands events the monitor held back to their window, as they came.
    ///
    /// # Safety
    /// On the main thread.
    unsafe fn replay(held: Vec<Retained<AnyObject>>) {
        REPLAYING.set(true);
        for event in held {
            let window: Option<Retained<AnyObject>> = unsafe { msg_send![&*event, window] };
            if let Some(window) = window {
                let _: () = unsafe { msg_send![&*window, sendEvent: &*event] };
            }
        }
        REPLAYING.set(false);
    }

    /// Whether a gesture starting with `event` may be a swipe back: the app
    /// has a page to go back to, no swipe is settling, the system's setting
    /// allows it, and it
    /// isn't over a web view that can go back, which swipes itself.
    ///
    /// # Safety
    /// `event` is an NSEvent, on the main thread.
    unsafe fn may_swipe(event: &AnyObject) -> bool {
        if !super::ENABLED.load(Ordering::Relaxed) {
            return false;
        }
        // The last one still springing to where it ended (or never heard to
        // end): it's settled now, and this gesture is nsh's.
        if unsafe { settle_swipe() } {
            return false;
        }
        let enabled: bool =
            unsafe { msg_send![class!(NSEvent), isSwipeTrackingFromScrollEventsEnabled] };
        if !enabled {
            return false;
        }
        let Some(content) = (unsafe { content_view(event) }) else {
            return false;
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

    /// The content view of `event`'s window.
    ///
    /// # Safety
    /// `event` is an NSEvent, on the main thread.
    unsafe fn content_view(event: &AnyObject) -> Option<Retained<AnyObject>> {
        let window: Option<Retained<AnyObject>> = unsafe { msg_send![event, window] };
        unsafe { msg_send![&*window?, contentView] }
    }

    /// The stack in `event`'s window, its top page and the page under it,
    /// if it has one.
    ///
    /// # Safety
    /// `event` is an NSEvent, on the main thread.
    unsafe fn pages(event: &AnyObject) -> Option<Pages> {
        let content = unsafe { content_view(event) }?;
        let stack = unsafe { find(&content) }?;
        let subviews: Retained<AnyObject> = unsafe { msg_send![&*stack, subviews] };
        let count: usize = unsafe { msg_send![&*subviews, count] };
        let screen = AnyClass::get(c"NshView")?;
        let mut screens = Vec::new();
        for i in 0..count {
            let v: Retained<AnyObject> = unsafe { msg_send![&*subviews, objectAtIndex: i] };
            let is_screen: Bool = unsafe { msg_send![&*v, isMemberOfClass: screen] };
            if is_screen.as_bool() {
                screens.push(v);
            }
        }
        let top_at = screens
            .iter()
            .rposition(|v| !unsafe { msg_send![&**v, isHidden] })?;
        let below = screens[..top_at].last()?.clone();
        let top = screens[top_at].clone();
        Some(Pages { stack, top, below })
    }

    /// The view named `STACK_ID` under `root`, nearest first.
    ///
    /// # Safety
    /// On the main thread.
    unsafe fn find(root: &AnyObject) -> Option<Retained<AnyObject>> {
        let name = NSString::from_str(STACK_ID);
        let mut level = vec![root.retain()];
        for _ in 0..16 {
            let mut next = Vec::new();
            for v in level {
                let id: Option<Retained<NSString>> =
                    unsafe { msg_send![&*v, accessibilityIdentifier] };
                if id.is_some_and(|id| *id == *name) {
                    return Some(v);
                }
                let subviews: Retained<AnyObject> = unsafe { msg_send![&*v, subviews] };
                let count: usize = unsafe { msg_send![&*subviews, count] };
                for i in 0..count {
                    next.push(unsafe { msg_send![&*subviews, objectAtIndex: i] });
                }
            }
            if next.is_empty() {
                return None;
            }
            level = next;
        }
        None
    }

    /// The layer of `view`.
    ///
    /// # Safety
    /// `view` is an NSView, on the main thread.
    unsafe fn layer(view: &AnyObject) -> Option<Retained<AnyObject>> {
        unsafe { msg_send![view, layer] }
    }

    /// Puts the pages where they are `amount` (0 to 1) of the way back.
    ///
    /// # Safety
    /// On the main thread.
    unsafe fn place(pages: &Pages, amount: f64) {
        let frame: NSRect = unsafe { msg_send![&*pages.stack, bounds] };
        let w = frame.size.width;
        unsafe {
            let _: () = msg_send![class!(CATransaction), begin];
            let _: () = msg_send![class!(CATransaction), setDisableActions: true];
            if let Some(l) = layer(&pages.top) {
                let _: () = msg_send![&*l, setAffineTransform: moved_by(w * amount)];
            }
            if let Some(l) = layer(&pages.below) {
                let _: () =
                    msg_send![&*l, setAffineTransform: moved_by(-PARALLAX * w * (1.0 - amount))];
            }
            let _: () = msg_send![class!(CATransaction), commit];
        }
    }

    /// Shows the page under the top one, with the top one's shadow over it.
    ///
    /// # Safety
    /// On the main thread.
    unsafe fn lift(pages: &Pages) {
        unsafe {
            let _: () = msg_send![&*pages.below, setHidden: false];
            if let Some(l) = layer(&pages.below) {
                let _: () = msg_send![&*l, setHidden: false];
            }
            if let Some(l) = layer(&pages.top) {
                let _: () = msg_send![&*l, setShadowOpacity: 0.18_f32];
                let _: () = msg_send![&*l, setShadowRadius: 12.0_f64];
                let _: () =
                    msg_send![&*l, setShadowOffset: objc2_foundation::NSSize::new(-2.0, 0.0)];
            }
        }
    }

    /// Puts the top page back as nsh left it, and the one under it away.
    ///
    /// # Safety
    /// On the main thread.
    unsafe fn put_back(pages: &Pages) {
        unsafe {
            place(pages, 0.0);
            settle(&pages.top);
            settle(&pages.below);
            let _: () = msg_send![&*pages.below, setHidden: true];
            if let Some(l) = layer(&pages.below) {
                let _: () = msg_send![&*l, setHidden: true];
            }
        }
    }

    /// Takes the swipe's transform and shadow off a page.
    ///
    /// # Safety
    /// `view` is an NSView, on the main thread.
    unsafe fn settle(view: &AnyObject) {
        if let Some(l) = unsafe { layer(view) } {
            unsafe {
                let _: () = msg_send![&*l, setAffineTransform: moved_by(0.0)];
                let _: () = msg_send![&*l, setShadowOpacity: 0.0_f32];
            }
        }
    }

    /// Hands the gesture starting at `event` to AppKit's swipe tracking,
    /// which moves `pages` with the fingers and then springs them to where
    /// the swipe ended.
    ///
    /// # Safety
    /// `event` is the gesture's scroll NSEvent, on the main thread.
    unsafe fn track(event: &AnyObject, pages: Pages) {
        let swipe = Rc::new(Swipe {
            pages: Rc::new(pages),
            went_back: Cell::new(false),
            done: Cell::new(false),
        });
        SWIPE.set(Some(swipe.clone()));
        let handler = RcBlock::new(
            move |amount: f64, phase: usize, complete: Bool, stop: *mut Bool| {
                // SAFETY: AppKit calls the handler on the main thread, with
                // `stop` pointing at its flag.
                unsafe {
                    if swipe.done.get() {
                        // Settled already (`abandon`): the pages aren't this
                        // tracking's any more.
                        if let Some(stop) = stop.as_mut() {
                            *stop = Bool::YES;
                        }
                        return;
                    }
                    let amount = amount.abs().clamp(0.0, 1.0);
                    let lets_go = phase & (ENDED | CANCELLED) != 0;
                    if lets_go || complete.as_bool() {
                        // The fingers let go: AppKit has decided which way
                        // (the distance and the flick), but its spring runs
                        // as long as the trackpad's momentum does. The pages
                        // glide the rest of the way on their own instead
                        // (`glide`), and the tracking stops.
                        if phase & ENDED != 0 {
                            swipe.went_back.set(true);
                        } else if phase & CANCELLED != 0 {
                            swipe.went_back.set(false);
                        }
                        swipe.done.set(true);
                        let rest = if complete.as_bool() {
                            Gesture::Idle
                        } else {
                            Gesture::Draining
                        };
                        GESTURE.with_borrow_mut(|g| {
                            if matches!(g, Gesture::Swiping) {
                                *g = rest;
                            }
                        });
                        if !complete.as_bool()
                            && let Some(stop) = stop.as_mut()
                        {
                            *stop = Bool::YES;
                        }
                        glide(swipe.clone(), amount);
                        return;
                    }
                    if phase & BEGAN != 0 {
                        lift(&swipe.pages);
                    }
                    place(&swipe.pages, amount);
                }
            },
        );
        unsafe {
            let _: () = msg_send![
                event,
                trackSwipeEventWithOptions: LOCK_DIRECTION | CLAMP_AMOUNT,
                dampenAmountThresholdMin: -1.0_f64,
                max: 1.0_f64,
                usingHandler: &*handler
            ];
        }
    }

    /// Glides the pages from `from` of the way back to the end the swipe
    /// went to, quickly and slowing down, then settles it: the app pops the
    /// page, or it's put back.
    ///
    /// # Safety
    /// On the main thread.
    unsafe fn glide(swipe: Rc<Swipe>, from: f64) {
        let back = swipe.went_back.get();
        let to = if back { 1.0 } else { 0.0 };
        let settled = {
            let swipe = swipe.clone();
            move || {
                SWIPE.with_borrow_mut(|s| {
                    if s.as_ref().is_some_and(|s| Rc::ptr_eq(s, &swipe)) {
                        *s = None;
                    }
                });
                // SAFETY: on the main thread (Core Animation's completion too).
                unsafe {
                    if back {
                        finish(swipe.pages.clone());
                    } else {
                        put_back(&swipe.pages);
                    }
                }
            }
        };
        let left = (to - from).abs();
        let pages = &swipe.pages;
        if left < 0.005 {
            unsafe { place(pages, to) };
            settled();
            return;
        }
        let duration = (GLIDE * left).max(GLIDE_MIN);
        let frame: NSRect = unsafe { msg_send![&*pages.stack, bounds] };
        let w = frame.size.width;
        let done = RcBlock::new(settled);
        unsafe {
            let _: () = msg_send![class!(CATransaction), begin];
            let _: () = msg_send![class!(CATransaction), setCompletionBlock: &*done];
            // Where they end up; the animations show the way there.
            place(pages, to);
            if let Some(l) = layer(&pages.top) {
                slide(&l, w * from, w * to, duration);
            }
            if let Some(l) = layer(&pages.below) {
                slide(
                    &l,
                    -PARALLAX * w * (1.0 - from),
                    -PARALLAX * w * (1.0 - to),
                    duration,
                );
            }
            let _: () = msg_send![class!(CATransaction), commit];
        }
    }

    /// Animates `layer` sideways from `from` to `to` points over `duration`.
    ///
    /// # Safety
    /// `layer` is a CALayer, on the main thread.
    unsafe fn slide(layer: &AnyObject, from: f64, to: f64, duration: f64) {
        unsafe {
            let path = NSString::from_str("transform.translation.x");
            let anim: Retained<AnyObject> =
                msg_send![class!(CABasicAnimation), animationWithKeyPath: &*path];
            let from: Retained<AnyObject> = msg_send![class!(NSNumber), numberWithDouble: from];
            let to: Retained<AnyObject> = msg_send![class!(NSNumber), numberWithDouble: to];
            let _: () = msg_send![&*anim, setFromValue: &*from];
            let _: () = msg_send![&*anim, setToValue: &*to];
            let _: () = msg_send![&*anim, setDuration: duration];
            // Fast at first, as the fingers left it, easing into place.
            let ease = NSString::from_str("easeOut");
            let timing: Retained<AnyObject> =
                msg_send![class!(CAMediaTimingFunction), functionWithName: &*ease];
            let _: () = msg_send![&*anim, setTimingFunction: &*timing];
            let key = NSString::from_str("swipe");
            let _: () = msg_send![layer, addAnimation: &*anim, forKey: &*key];
        }
    }

    /// The swipe went back: the top page is off to the right, and the app
    /// pops it. A moment later, whatever the app did, the pages lose the
    /// swipe's transforms: nsh has hidden or removed the top one by then,
    /// or it stays and comes back into view.
    ///
    /// # Safety
    /// On the main thread.
    unsafe fn finish(pages: Rc<Pages>) {
        unsafe { settle(&pages.below) };
        super::emit();
        let pages = SendPages(pages);
        let Ok(later) = dispatch2::DispatchTime::try_from(std::time::Duration::from_millis(600))
        else {
            return;
        };
        let _ = dispatch2::DispatchQueue::main().after(later, move || {
            let pages = pages;
            // SAFETY: on the main thread, where the pages were made.
            unsafe {
                let top_hidden: bool = msg_send![&*pages.0.top, isHidden];
                let top_in: Option<Retained<AnyObject>> = msg_send![&*pages.0.top, superview];
                if top_in.is_some() && !top_hidden {
                    // Not popped: back as it was.
                    put_back(&pages.0);
                } else {
                    settle(&pages.0.top);
                }
            }
        });
    }

    /// The pages, carried to a later turn of the main queue.
    struct SendPages(Rc<Pages>);
    // SAFETY: made and used on the main thread only; the main queue runs
    // the closure there.
    unsafe impl Send for SendPages {}
}
