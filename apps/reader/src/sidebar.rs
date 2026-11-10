//! The window's sidebar on macOS: the system's own, an `NSSplitViewController`
//! sidebar item, which AppKit draws as a pane of Liquid Glass on macOS 26
//! (with its shadow, its edge and the window's inactive look), where nsh's
//! `glassEffect` can only put a bare glass view over the paper.
//!
//! nsh owns the window's content view, so the split view goes under it, in
//! the window's frame view, filling the same rect. It only draws: nsh's root
//! lies over it, transparent where the sidebar is, draws the sidebar's rows
//! (`Sources`) on the glass and takes every click. The split view's items
//! are empty views, the sidebar's as wide as the app's.
//!
//! nsh paints the view holding its root (the window's content view) in the
//! scheme's black or white when the app's root isn't opaque, and paints it
//! again when the scheme changes; that would hide the glass. The host view
//! clears it once the sidebar is in, and again whenever the appearance
//! changes, after nsh has painted it.

#[cfg(not(target_os = "macos"))]
pub fn show(_width: f64) {}

#[cfg(not(target_os = "macos"))]
pub fn hide() {}

#[cfg(target_os = "macos")]
pub use mac::{hide, show};

#[cfg(target_os = "macos")]
mod mac {
    use std::cell::RefCell;

    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2::{Encoding, MainThreadOnly, RefEncode, class, define_class, msg_send};
    use objc2_app_kit::NSView;
    use objc2_foundation::{NSPoint, NSRect};

    /// Core Graphics' color, only ever passed by pointer (`CGColorRef`).
    #[repr(C)]
    struct CGColor {
        _private: [u8; 0],
    }

    // SAFETY: `CGColorRef` is a pointer to the opaque struct `CGColor`.
    unsafe impl RefEncode for CGColor {
        const ENCODING_REF: Encoding = Encoding::Pointer(&Encoding::Struct("CGColor", &[]));
    }

    /// The host view, the split view controller and its sidebar item, while shown.
    struct Shown {
        host: Retained<Host>,
        _split: Retained<AnyObject>,
        side: Retained<AnyObject>,
    }

    thread_local! {
        static SHOWN: RefCell<Option<Shown>> = const { RefCell::new(None) };
    }

    define_class!(
        /// Holds the split view under nsh's root, and keeps the root's
        /// holder clear while it's in the window.
        #[unsafe(super(NSView))]
        #[thread_kind = MainThreadOnly]
        #[name = "LofuSidebarHost"]
        struct Host;

        impl Host {
            #[unsafe(method(viewDidChangeEffectiveAppearance))]
            fn appearance_changed(&self) {
                // nsh repaints the holder for the new scheme in this same
                // pass; clear it after.
                dispatch2::DispatchQueue::main().exec_async(|| {
                    // SAFETY: on the main thread.
                    unsafe { clear_holder() };
                });
            }

            #[unsafe(method(hitTest:))]
            fn hit_test(&self, _point: NSPoint) -> *mut AnyObject {
                // Clicks are the app's: nsh's root lies over the sidebar.
                std::ptr::null_mut()
            }
        }
    );

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
            let windows: Retained<AnyObject> = msg_send![&*app, windows];
            msg_send![&*windows, firstObject]
        }
    }

    /// Clears the background nsh paints on its root's holder, the window's
    /// content view, so the sidebar's glass shows through the root.
    unsafe fn clear_holder() {
        unsafe {
            let Some(host) = SHOWN.with(|s| s.borrow().as_ref().map(|s| s.host.clone())) else {
                return;
            };
            let Some(window): Option<Retained<AnyObject>> = msg_send![&*host, window] else {
                return;
            };
            let Some(content): Option<Retained<AnyObject>> = msg_send![&*window, contentView]
            else {
                return;
            };
            let Some(layer): Option<Retained<AnyObject>> = msg_send![&*content, layer] else {
                return;
            };
            // A CGColorRef, not an object: debug builds check the argument's
            // encoding and panic on `@`.
            let none: *const CGColor = std::ptr::null();
            let _: () = msg_send![class!(CATransaction), begin];
            let _: () = msg_send![class!(CATransaction), setDisableActions: true];
            let _: () = msg_send![&*layer, setBackgroundColor: none];
            let _: () = msg_send![class!(CATransaction), commit];
        }
    }

    /// A view controller with an empty view.
    unsafe fn controller() -> Retained<AnyObject> {
        unsafe {
            let vc: Retained<AnyObject> = msg_send![class!(NSViewController), new];
            let view: Retained<AnyObject> = msg_send![class!(NSView), new];
            let _: () = msg_send![&*vc, setView: &*view];
            vc
        }
    }

    unsafe fn install(width: f64) {
        unsafe {
            let resized = SHOWN.with(|s| {
                s.borrow().as_ref().map(|shown| {
                    let _: () = msg_send![&*shown.side, setMinimumThickness: width];
                    let _: () = msg_send![&*shown.side, setMaximumThickness: width];
                })
            });
            if resized.is_some() {
                clear_holder();
                return;
            }
            let Some(window) = window() else { return };
            let Some(content): Option<Retained<AnyObject>> = msg_send![&*window, contentView]
            else {
                return;
            };
            let Some(frame_view): Option<Retained<AnyObject>> = msg_send![&*content, superview]
            else {
                return;
            };
            let split: Retained<AnyObject> = msg_send![class!(NSSplitViewController), new];
            let side: Retained<AnyObject> =
                msg_send![class!(NSSplitViewItem), sidebarWithViewController: &*controller()];
            let _: () = msg_send![&*side, setMinimumThickness: width];
            let _: () = msg_send![&*side, setMaximumThickness: width];
            let _: () = msg_send![&*side, setCanCollapse: false];
            let main: Retained<AnyObject> =
                msg_send![class!(NSSplitViewItem), splitViewItemWithViewController: &*controller()];
            let _: () = msg_send![&*split, addSplitViewItem: &*side];
            let _: () = msg_send![&*split, addSplitViewItem: &*main];

            let frame: NSRect = msg_send![&*content, frame];
            let host: Retained<Host> = msg_send![
                Host::alloc(objc2::MainThreadMarker::new_unchecked()),
                initWithFrame: frame
            ];
            // NSViewWidthSizable | NSViewHeightSizable.
            let _: () = msg_send![&*host, setAutoresizingMask: 18usize];
            let view: Retained<AnyObject> = msg_send![&*split, view];
            let bounds: NSRect = msg_send![&*host, bounds];
            let _: () = msg_send![&*view, setFrame: bounds];
            let _: () = msg_send![&*view, setAutoresizingMask: 18usize];
            let _: () = msg_send![&*host, addSubview: &*view];
            // NSWindowBelow: under nsh's root.
            let _: () = msg_send![
                &*frame_view,
                addSubview: &*host,
                positioned: -1isize,
                relativeTo: &*content
            ];
            SHOWN.with(|s| {
                *s.borrow_mut() = Some(Shown {
                    host,
                    _split: split,
                    side,
                })
            });
            clear_holder();
        }
    }

    unsafe fn remove() {
        if let Some(shown) = SHOWN.with(|s| s.borrow_mut().take()) {
            unsafe {
                let _: () = msg_send![&*shown.host, removeFromSuperview];
            }
        }
    }

    /// Puts the system's sidebar, `width` points wide, under the window's content.
    pub fn show(width: f64) {
        dispatch2::DispatchQueue::main().exec_async(move || {
            // SAFETY: on the main thread, with AppKit's own classes.
            unsafe { install(width) };
        });
    }

    /// Takes the sidebar away (a narrow window, the sign-in page). nsh
    /// paints its root's holder again when the app's root is opaque.
    pub fn hide() {
        dispatch2::DispatchQueue::main().exec_async(|| {
            // SAFETY: on the main thread.
            unsafe { remove() };
        });
    }
}
