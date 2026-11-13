//! `lofu.scrollEdge` (iOS 26): the system's own scroll edge effect, where
//! the app had to imitate it with a backdrop blur (`TopEdge`, `BottomEdge`).
//!
//! UIKit draws the effect (the page blurring and fading out under the bars'
//! glass) on a page's scroll view once it knows which one it is. It finds it
//! when a screen's view *is* the scroll view, and nsh's never is: the
//! scroll view of a `List` or a `RichEditor` sits deep under the screen.
//! This component, an empty view placed in the page, tells UIKit:
//!
//! - `edge: "top"`: the screen's controller is given the scroll view
//!   (`setContentScrollView:forEdge:`), and the navigation bar is made a
//!   container of elements over its top edge, so the bar's glass gets the
//!   effect beneath it, as in any UIKit app. (nsh insets its pages itself,
//!   and the bar doesn't take the effect from the controller alone.)
//! - `edge: "bottom"`: the view holding the component (the row of controls
//!   floating at the page's foot) gets a `UIScrollEdgeElementContainerInteraction`
//!   for the scroll view's bottom edge, so the effect is shaped around its
//!   glass, the search field and the buttons.
//!
//! The page's scroll view is the first one big enough to be the page (half
//! the screen's height) under the screen's view, breadth first. Pages mount
//! their views in any order, so it looks again on every layout until it
//! finds one, and drops what it set up when it leaves the window.

use std::cell::RefCell;
use std::rc::Rc;

use nsh_core::JsonValue;
use nsh_platform_ios::{ComponentContext, Components, NativeComponent};
use objc2::rc::{Retained, Weak};
use objc2::runtime::{AnyClass, AnyObject};
use objc2::{DefinedClass, MainThreadMarker, MainThreadOnly, class, define_class, msg_send};
use objc2_foundation::{NSPoint, NSRect};
use objc2_ui_kit::UIView;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Edge {
    Top,
    Bottom,
}

#[derive(Default)]
struct State {
    edge: Option<Edge>,
    /// The scroll view it was attached to.
    scroll: Option<Weak<AnyObject>>,
    /// The interaction and the view it was added to: the navigation bar
    /// (`top`) or the row of controls (`bottom`).
    interaction: Option<(Retained<AnyObject>, Weak<AnyObject>)>,
    /// `top`: the controller given the scroll view.
    controller: Option<Weak<AnyObject>>,
}

define_class!(
    /// The component's view: empty, lets touches through, and attaches its
    /// page's scroll view when it moves into a window and as it's laid out.
    #[unsafe(super(UIView))]
    #[thread_kind = MainThreadOnly]
    #[name = "LofuScrollEdgeView"]
    #[ivars = RefCell<State>]
    struct EdgeView;

    impl EdgeView {
        #[unsafe(method(didMoveToWindow))]
        fn did_move_to_window(&self) {
            // SAFETY: UIView's own method, on the main thread.
            let _: () = unsafe { msg_send![super(self), didMoveToWindow] };
            let window: Option<Retained<AnyObject>> = unsafe { msg_send![self, window] };
            if window.is_some() {
                self.attach();
            } else {
                self.detach();
            }
        }

        #[unsafe(method(layoutSubviews))]
        fn layout_subviews(&self) {
            // SAFETY: UIView's own method, on the main thread.
            let _: () = unsafe { msg_send![super(self), layoutSubviews] };
            self.attach();
        }
    }
);

impl EdgeView {
    fn new(mtm: MainThreadMarker) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(RefCell::new(State::default()));
        // SAFETY: UIView's designated initializer, then plain setters.
        unsafe {
            let this: Retained<Self> = msg_send![super(this), initWithFrame: NSRect::ZERO];
            let _: () = msg_send![&*this, setUserInteractionEnabled: false];
            let _: () = msg_send![&*this, setAccessibilityElementsHidden: true];
            this
        }
    }

    /// The edge effect's APIs, which iOS 26 brought.
    fn supported() -> bool {
        AnyClass::get(c"UIScrollEdgeElementContainerInteraction").is_some()
    }

    fn set_edge(&self, edge: Option<Edge>) {
        if self.ivars().borrow().edge == edge {
            return;
        }
        self.detach();
        self.ivars().borrow_mut().edge = edge;
        self.attach();
    }

    /// Finds the page's scroll view and hands it to UIKit: once, and again
    /// when the page's scroll view is another (the library's layout changed).
    fn attach(&self) {
        let Some(edge) = self.ivars().borrow().edge else {
            return;
        };
        if !Self::supported() {
            return;
        }
        // SAFETY: UIKit's own classes and methods, on the main thread.
        unsafe {
            let window: Option<Retained<AnyObject>> = msg_send![self, window];
            if window.is_none() {
                return;
            }
            let Some(controller) = controller_of(self) else {
                return;
            };
            let Some(root) = msg_send![&*controller, viewIfLoaded] else {
                return;
            };
            let root: Retained<AnyObject> = root;
            let Some(scroll) = page_scroll_view(&root) else {
                return;
            };
            if edge == Edge::Top {
                tallest_top(&controller, &root, &scroll);
            }
            let current = self.ivars().borrow().scroll.as_ref().and_then(|s| s.load());
            if current.is_some_and(|c| Retained::as_ptr(&c) == Retained::as_ptr(&scroll)) {
                return;
            }
            self.detach();
            let mut state = self.ivars().borrow_mut();
            match edge {
                Edge::Top => {
                    // A scroll view made after the page's first (the library's
                    // layout changed) comes with no inset adjustment: nsh gives
                    // UIKit's automatic one only to those the page mounts with,
                    // and the bar's height to the content with it. It takes
                    // what the one it replaces had.
                    let previous: Option<Retained<AnyObject>> =
                        msg_send![&*controller, contentScrollViewForEdge: 1usize];
                    if let Some(previous) = previous
                        && Retained::as_ptr(&previous) != Retained::as_ptr(&scroll)
                    {
                        let theirs: isize = msg_send![&*previous, contentInsetAdjustmentBehavior];
                        let ours: isize = msg_send![&*scroll, contentInsetAdjustmentBehavior];
                        if theirs != ours {
                            let _: () = msg_send![&*scroll, setContentInsetAdjustmentBehavior: theirs];
                            // Its content starts at the top of the inset it now
                            // has (under the large title), not under the bar.
                            // With the large title shown, as a page opens, even
                            // if the list it replaces had been scrolled under the
                            // bar: UIKit opens the title out as it follows.
                            let offset: NSPoint = msg_send![&*scroll, contentOffset];
                            if offset.y == 0.0 {
                                let inset: Insets = msg_send![&*scroll, contentInset];
                                let top = NSPoint {
                                    x: offset.x,
                                    y: -(tallest_top(&controller, &root, &scroll) + inset.top),
                                };
                                let _: () = msg_send![&*scroll, setContentOffset: top];
                            }
                        }
                    }
                    // NSDirectionalRectEdgeTop
                    let _: () = msg_send![&*controller, setContentScrollView: &*scroll, forEdge: 1usize];
                    state.controller = Some(Weak::from_retained(&controller));
                    // nsh insets the page itself, so the bar doesn't take the
                    // effect from the controller alone: the bar is also made
                    // a container of elements over the scroll view's top edge.
                    let nav: Option<Retained<AnyObject>> = msg_send![&*controller, navigationController];
                    if let Some(nav) = nav {
                        let bar: Retained<AnyObject> = msg_send![&*nav, navigationBar];
                        let interaction = edge_interaction(&scroll, 1);
                        let _: () = msg_send![&*bar, addInteraction: &*interaction];
                        state.interaction = Some((interaction, Weak::from_retained(&bar)));
                    }
                }
                Edge::Bottom => {
                    // The row of controls: the component's host container's parent.
                    let host: Option<Retained<AnyObject>> = msg_send![self, superview];
                    let Some(row) = host.and_then(|h| {
                        let row: Option<Retained<AnyObject>> = msg_send![&*h, superview];
                        row
                    }) else {
                        return;
                    };
                    // UIRectEdgeBottom
                    let interaction = edge_interaction(&scroll, 4);
                    let _: () = msg_send![&*row, addInteraction: &*interaction];
                    state.interaction = Some((interaction, Weak::from_retained(&row)));
                }
            }
            state.scroll = Some(Weak::from_retained(&scroll));
        }
    }

    /// Undoes `attach`: the page is leaving, or the edge changed.
    fn detach(&self) {
        let mut state = self.ivars().borrow_mut();
        state.scroll = None;
        // SAFETY: UIKit's own methods, on the main thread.
        unsafe {
            if let Some((interaction, row)) = state.interaction.take()
                && let Some(row) = row.load()
            {
                let _: () = msg_send![&*row, removeInteraction: &*interaction];
            }
            // The controller keeps the scroll view: it's the page's own, and
            // a component made again for the same page may have set it already.
            state.controller = None;
        }
    }
}

thread_local! {
    /// The tallest top safe area each page's scroll view has had (its bar
    /// with the large title open), by controller and by the width of its
    /// view: turned on its side, a phone's bar has no large title.
    static TALLEST: RefCell<Vec<(Weak<AnyObject>, u32, f64)>> = const { RefCell::new(Vec::new()) };
}

/// The top of `scroll`'s safe area with its page's large title open (at
/// this width): the tallest it has been (it's shorter while the title is folded).
unsafe fn tallest_top(controller: &Retained<AnyObject>, root: &AnyObject, scroll: &AnyObject) -> f64 {
    let now: Insets = unsafe { msg_send![scroll, safeAreaInsets] };
    let bounds: NSRect = unsafe { msg_send![root, bounds] };
    let width = bounds.size.width.round() as u32;
    TALLEST.with_borrow_mut(|seen| {
        seen.retain(|(c, _, _)| c.load().is_some());
        let at = seen.iter().position(|(c, w, _)| {
            *w == width
                && c.load().is_some_and(|c| Retained::as_ptr(&c) == Retained::as_ptr(controller))
        });
        match at {
            Some(i) => {
                seen[i].2 = seen[i].2.max(now.top);
                seen[i].2
            }
            None => {
                seen.push((Weak::from_retained(controller), width, now.top));
                now.top
            }
        }
    })
}

/// `UIEdgeInsets`.
#[repr(C)]
#[derive(Clone, Copy)]
struct Insets {
    top: f64,
    left: f64,
    bottom: f64,
    right: f64,
}

// SAFETY: the layout of UIKit's `UIEdgeInsets` (four `CGFloat`s).
unsafe impl objc2::Encode for Insets {
    const ENCODING: objc2::Encoding = objc2::Encoding::Struct(
        "UIEdgeInsets",
        &[f64::ENCODING, f64::ENCODING, f64::ENCODING, f64::ENCODING],
    );
}

/// An interaction marking its view as holding elements over `scroll`'s `edge` (a `UIRectEdge`).
unsafe fn edge_interaction(scroll: &AnyObject, edge: usize) -> Retained<AnyObject> {
    unsafe {
        let interaction: Retained<AnyObject> =
            msg_send![class!(UIScrollEdgeElementContainerInteraction), new];
        let _: () = msg_send![&*interaction, setScrollView: scroll];
        let _: () = msg_send![&*interaction, setEdge: edge];
        interaction
    }
}

/// The view controller whose view holds `view`: the first in its responder chain.
unsafe fn controller_of(view: &AnyObject) -> Option<Retained<AnyObject>> {
    unsafe {
        let mut next: Option<Retained<AnyObject>> = msg_send![view, nextResponder];
        while let Some(r) = next {
            let is_controller: bool = msg_send![&*r, isKindOfClass: class!(UIViewController)];
            if is_controller {
                return Some(r);
            }
            next = msg_send![&*r, nextResponder];
        }
        None
    }
}

/// The page's scroll view under `root`: the first (breadth first) at least
/// half as tall as `root`, so a row of chips scrolling sideways isn't taken.
unsafe fn page_scroll_view(root: &AnyObject) -> Option<Retained<AnyObject>> {
    unsafe {
        let bounds: NSRect = msg_send![root, bounds];
        let min_height = bounds.size.height / 2.0;
        let mut queue: Vec<Retained<AnyObject>> = vec![msg_send![root, self]];
        while !queue.is_empty() {
            let mut next = Vec::new();
            for v in queue {
                let subviews: Retained<objc2_foundation::NSArray<AnyObject>> =
                    msg_send![&*v, subviews];
                for child in subviews.iter() {
                    let scrolls: bool = msg_send![&*child, isKindOfClass: class!(UIScrollView)];
                    let hidden: bool = msg_send![&*child, isHidden];
                    if scrolls && !hidden {
                        let frame: NSRect = msg_send![&*child, frame];
                        if frame.size.height >= min_height {
                            return Some(child);
                        }
                    }
                    next.push(child);
                }
            }
            queue = next;
        }
        None
    }
}

struct ScrollEdge {
    view: Retained<EdgeView>,
}

impl NativeComponent for ScrollEdge {
    fn view(&self) -> &UIView {
        &self.view
    }

    fn set_prop(&mut self, name: &str, value: Option<&JsonValue>) {
        if name == "edge" {
            let edge = match value.and_then(JsonValue::as_str) {
                Some("top") => Some(Edge::Top),
                Some("bottom") => Some(Edge::Bottom),
                _ => None,
            };
            self.view.set_edge(edge);
        }
    }
}

impl Drop for ScrollEdge {
    fn drop(&mut self) {
        self.view.detach();
    }
}

pub fn register(components: &Components) {
    components.register(
        "lofu.scrollEdge",
        Rc::new(|_cx: ComponentContext| {
            let mtm = MainThreadMarker::new().expect("components are made on the main thread");
            Box::new(ScrollEdge {
                view: EdgeView::new(mtm),
            })
        }),
    );
}

/// Whether `lofu.scrollEdge` does anything here (iOS 26 and later).
pub fn available() -> bool {
    EdgeView::supported()
}
