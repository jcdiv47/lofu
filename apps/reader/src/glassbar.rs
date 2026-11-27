//! `lofu.glassBar` (iOS): a row of the system's symbol buttons on one capsule
//! of interactive Liquid Glass, as Safari's bar along the bottom on iOS 26
//! (`UIVisualEffectView` with a `UIGlassEffect`, the buttons in its content).
//! nsh's `glassEffect` draws the material but not how the system's glass
//! answers a touch; this one swells and lights up under the finger.
//!
//! Props: `items` (`[{ id, symbol, label, disabled? }]`), `tint` (the
//! symbols' color; by default the label color, which the glass adapts to
//! what's behind it), `height`. Sends `tap` with `{ id, x, y }` (the button's
//! middle in the window). It sizes itself to its buttons.

use std::rc::Rc;

use block2::RcBlock;
use nsh_core::JsonValue;
use nsh_platform_ios::{ComponentContext, Components, NativeComponent};
use objc2::rc::{Allocated, Retained};
use objc2::runtime::{AnyClass, AnyObject};
use objc2::{class, msg_send, sel};
use objc2_foundation::{NSPoint, NSRect, NSSize, NSString};
use objc2_ui_kit::UIView;

use crate::controls::parse_color;

/// UIControlEventPrimaryActionTriggered.
const PRIMARY_ACTION: usize = 1 << 13;
/// UIViewAutoresizingFlexibleWidth | FlexibleHeight.
const FILL: usize = 2 | 16;
/// Each button's width, and the room at the capsule's ends.
const BUTTON: f64 = 48.0;
const END: f64 = 10.0;
const GAP: f64 = 6.0;

struct Item {
    id: String,
    symbol: String,
    label: String,
    disabled: bool,
}

fn items(value: Option<&JsonValue>) -> Vec<Item> {
    let Some(list) = value.and_then(JsonValue::as_array) else {
        return Vec::new();
    };
    list.iter()
        .filter_map(|v| {
            Some(Item {
                id: v.get("id")?.as_str()?.to_owned(),
                symbol: v.get("symbol")?.as_str()?.to_owned(),
                label: v
                    .get("label")
                    .and_then(JsonValue::as_str)
                    .unwrap_or("")
                    .to_owned(),
                disabled: v
                    .get("disabled")
                    .and_then(JsonValue::as_bool)
                    .unwrap_or(false),
            })
        })
        .collect()
}

struct GlassBar {
    root: Retained<UIView>,
    stack: Retained<AnyObject>,
    items: Vec<Item>,
    tint: Option<[f64; 4]>,
    height: f64,
    cx: ComponentContext,
}

impl GlassBar {
    fn new(cx: ComponentContext) -> Self {
        // SAFETY: UIKit's own classes, on the main thread.
        unsafe {
            let frame = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(240.0, 56.0));
            let root: Retained<UIView> = msg_send![class!(UIView), new];
            let _: () = msg_send![&*root, setFrame: frame];
            let _: () = msg_send![&*root, setAutoresizingMask: FILL];

            let glass: Allocated<AnyObject> = msg_send![class!(UIVisualEffectView), alloc];
            let glass: Retained<AnyObject> =
                msg_send![glass, initWithEffect: Option::<&AnyObject>::None];
            let _: () = msg_send![&*glass, setFrame: frame];
            let _: () = msg_send![&*glass, setAutoresizingMask: FILL];
            let capsule: bool = msg_send![
                class!(UIView),
                instancesRespondToSelector: sel!(setCornerConfiguration:)
            ];
            if capsule {
                let corners: Retained<AnyObject> =
                    msg_send![class!(UICornerConfiguration), capsuleConfiguration];
                let _: () = msg_send![&*glass, setCornerConfiguration: &*corners];
            } else {
                let _: () = msg_send![&*glass, setClipsToBounds: true];
                let layer: Retained<AnyObject> = msg_send![&*glass, layer];
                let _: () = msg_send![&*layer, setCornerRadius: 28.0f64];
            }
            let effect: Retained<AnyObject> = match AnyClass::get(c"UIGlassEffect") {
                Some(cls) => {
                    let effect: Retained<AnyObject> = msg_send![cls, effectWithStyle: 0isize];
                    let _: () = msg_send![&*effect, setInteractive: true];
                    effect
                }
                // UIBlurEffectStyleSystemMaterial
                None => msg_send![class!(UIBlurEffect), effectWithStyle: 8isize],
            };
            let _: () = msg_send![&*glass, setEffect: &*effect];
            let _: () = msg_send![&*root, addSubview: &*glass];

            let stack: Retained<AnyObject> = msg_send![class!(UIStackView), new];
            let _: () = msg_send![&*stack, setAxis: 0isize]; // horizontal
            let _: () = msg_send![&*stack, setDistribution: 1isize]; // fill equally
            let _: () = msg_send![&*stack, setAlignment: 0isize]; // fill
            let _: () = msg_send![&*stack, setSpacing: GAP];
            let _: () = msg_send![
                &*stack,
                setFrame: NSRect::new(NSPoint::new(END, 0.0), NSSize::new(240.0 - 2.0 * END, 56.0))
            ];
            let _: () = msg_send![&*stack, setAutoresizingMask: FILL];
            let content: Retained<AnyObject> = msg_send![&*glass, contentView];
            let _: () = msg_send![&*content, addSubview: &*stack];

            GlassBar {
                root,
                stack,
                items: Vec::new(),
                tint: None,
                height: 56.0,
                cx,
            }
        }
    }

    /// Makes the buttons again, for new items or a new tint.
    unsafe fn rebuild(&self) {
        unsafe {
            let old: Retained<objc2_foundation::NSArray<AnyObject>> =
                msg_send![&*self.stack, arrangedSubviews];
            for view in old.iter() {
                let _: () = msg_send![&*view, removeFromSuperview];
            }
            // The system's label color unless told otherwise: the glass
            // turns it light or dark with what's behind it.
            let tint: Retained<AnyObject> = match self.tint {
                Some(c) => color(c),
                None => msg_send![class!(UIColor), labelColor],
            };
            for item in &self.items {
                let config: Retained<AnyObject> =
                    msg_send![class!(UIButtonConfiguration), plainButtonConfiguration];
                let image: Option<Retained<AnyObject>> = msg_send![
                    class!(UIImage),
                    systemImageNamed: &*NSString::from_str(&item.symbol)
                ];
                let _: () = msg_send![&*config, setImage: image.as_deref()];
                let symbols: Retained<AnyObject> = msg_send![
                    class!(UIImageSymbolConfiguration),
                    configurationWithPointSize: 19.0f64,
                    weight: 5isize // medium
                ];
                let _: () = msg_send![&*config, setPreferredSymbolConfigurationForImage: &*symbols];
                let _: () = msg_send![&*config, setBaseForegroundColor: &*tint];
                let button: Retained<AnyObject> = msg_send![class!(UIButton), buttonWithConfiguration: &*config, primaryAction: Option::<&AnyObject>::None];
                let _: () = msg_send![&*button, setEnabled: !item.disabled];
                let label = NSString::from_str(&item.label);
                let _: () = msg_send![&*button, setAccessibilityLabel: &*label];
                let _: () =
                    msg_send![&*button, setAccessibilityIdentifier: &*NSString::from_str(&item.id)];
                let cx = self.cx.clone();
                let id = item.id.clone();
                let handler = RcBlock::new(move |action: *mut AnyObject| {
                    // SAFETY: UIKit passes the UIAction that ran, on the main thread.
                    let sender: Option<Retained<AnyObject>> = msg_send![action, sender];
                    let (x, y) = sender.map(|s| middle(&s)).unwrap_or((0.0, 0.0));
                    cx.emit("tap", serde_json::json!({ "id": id, "x": x, "y": y }));
                });
                let action: Retained<AnyObject> =
                    msg_send![class!(UIAction), actionWithHandler: &*handler];
                let _: () =
                    msg_send![&*button, addAction: &*action, forControlEvents: PRIMARY_ACTION];
                let _: () = msg_send![&*self.stack, addArrangedSubview: &*button];
            }
            let n = self.items.len() as f64;
            let width = 2.0 * END + n * BUTTON + (n - 1.0).max(0.0) * GAP;
            self.cx.set_size(width as f32, self.height as f32);
        }
    }
}

unsafe fn color(rgba: [f64; 4]) -> Retained<AnyObject> {
    unsafe {
        msg_send![
            class!(UIColor),
            colorWithRed: rgba[0],
            green: rgba[1],
            blue: rgba[2],
            alpha: rgba[3]
        ]
    }
}

/// The middle of `view` in its window.
fn middle(view: &AnyObject) -> (f64, f64) {
    // SAFETY: UIView's geometry, on the main thread.
    unsafe {
        let b: NSRect = msg_send![view, bounds];
        let p: NSPoint = msg_send![
            view,
            convertPoint: NSPoint::new(b.size.width / 2.0, b.size.height / 2.0),
            toView: Option::<&AnyObject>::None
        ];
        (p.x, p.y)
    }
}

impl NativeComponent for GlassBar {
    fn view(&self) -> &UIView {
        &self.root
    }

    fn set_prop(&mut self, name: &str, value: Option<&JsonValue>) {
        match name {
            "items" => self.items = items(value),
            "tint" => self.tint = parse_color(value),
            "height" => self.height = value.and_then(JsonValue::as_f64).unwrap_or(56.0),
            _ => return,
        }
        // SAFETY: on the main thread, with the views made in `new`.
        unsafe { self.rebuild() };
    }
}

pub fn register(components: &Components) {
    components.register("lofu.glassBar", Rc::new(|cx| Box::new(GlassBar::new(cx))));
}
