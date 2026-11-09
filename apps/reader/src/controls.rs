//! The system's own controls, as native components (`nativeComponent` in
//! `components/native.tsx`), where nsh's views can only imitate them:
//!
//! - `lofu.glassButton`: a button of Liquid Glass showing an SF Symbol (and
//!   a title): `UIButton` with a glass configuration on iOS 26, `NSButton`
//!   with the glass bezel on macOS 26. On iOS its glass answers the touch
//!   (it swells and lights up under the finger), which a view with
//!   `glassEffect` doesn't.
//! - `lofu.searchField` (iOS): `UISearchTextField` on a capsule of
//!   interactive glass, with the system's magnifier, clear button, caret
//!   and keyboard handling. macOS keeps the app's own field: nsh 0.4 never
//!   hands a click to a component's view there (see `native.tsx`).
//!
//! Props arrive as JSON (`set_prop`), each when it changes and all of them
//! right after the component is made; events go back with `cx.emit`. UIKit
//! and AppKit call all of it on the main thread.

use nsh_core::JsonValue;

/// A color from `#rgb`, `#rrggbb` or `#rrggbbaa`, as sRGB components 0…1.
pub(crate) fn parse_color(value: Option<&JsonValue>) -> Option<[f64; 4]> {
    let hex = value?.as_str()?.strip_prefix('#')?;
    let digits: Vec<u8> = hex
        .chars()
        .map(|c| c.to_digit(16).map(|d| d as u8))
        .collect::<Option<_>>()?;
    let pair = |i: usize| f64::from(digits[i] * 16 + digits[i + 1]) / 255.0;
    match digits.len() {
        3 => Some([
            f64::from(digits[0] * 17) / 255.0,
            f64::from(digits[1] * 17) / 255.0,
            f64::from(digits[2] * 17) / 255.0,
            1.0,
        ]),
        6 => Some([pair(0), pair(2), pair(4), 1.0]),
        8 => Some([pair(0), pair(2), pair(4), pair(6)]),
        _ => None,
    }
}

fn string(value: Option<&JsonValue>) -> Option<String> {
    value?.as_str().filter(|s| !s.is_empty()).map(str::to_owned)
}

fn number(value: Option<&JsonValue>) -> Option<f64> {
    value?.as_f64()
}

fn boolean(value: Option<&JsonValue>, default: bool) -> bool {
    value.and_then(JsonValue::as_bool).unwrap_or(default)
}

/// What a glass button shows, as the props set it.
#[derive(Default)]
struct ButtonProps {
    symbol: Option<String>,
    title: Option<String>,
    /// `glass` (default), `prominent` (filled with `tint`), `clear`, `plain`.
    variant: Option<String>,
    tint: Option<[f64; 4]>,
    /// The symbol's point size.
    size: Option<f64>,
    /// `regular`, `medium`, `semibold`, `bold`.
    weight: Option<String>,
    label: Option<String>,
    disabled: bool,
    /// macOS: `regular` or `large`; by default a toolbar's (extra large).
    control_size: Option<String>,
}

impl ButtonProps {
    /// Takes prop `name`; false for a prop it doesn't know.
    fn set(&mut self, name: &str, value: Option<&JsonValue>) -> bool {
        match name {
            "symbol" => self.symbol = string(value),
            "title" => self.title = string(value),
            "variant" => self.variant = string(value),
            "tint" => self.tint = parse_color(value),
            "size" => self.size = number(value),
            "weight" => self.weight = string(value),
            "label" => self.label = string(value),
            "disabled" => self.disabled = boolean(value, false),
            "controlSize" => self.control_size = string(value),
            _ => return false,
        }
        true
    }

    fn variant(&self) -> &str {
        self.variant.as_deref().unwrap_or("glass")
    }
}

#[cfg(target_os = "ios")]
pub mod ios {
    use std::rc::Rc;

    use block2::RcBlock;
    use nsh_core::JsonValue;
    use nsh_platform_ios::{ComponentContext, Components, NativeComponent};
    use objc2::rc::{Allocated, Retained};
    use objc2::runtime::{AnyClass, AnyObject};
    use objc2::{class, msg_send, sel};
    use objc2_foundation::{NSPoint, NSRect, NSSize, NSString};
    use objc2_ui_kit::UIView;

    use super::{ButtonProps, boolean, number, parse_color, string};

    // UIControlEvents
    const PRIMARY_ACTION: usize = 1 << 13;
    const EDITING_BEGAN: usize = 1 << 16;
    const EDITING_CHANGED: usize = 1 << 17;
    const EDITING_ENDED: usize = 1 << 18;
    const EDITING_ENDED_ON_EXIT: usize = 1 << 19;
    /// UIViewAutoresizingFlexibleWidth | FlexibleHeight.
    const FILL: usize = 2 | 16;

    pub fn register(components: &Components) {
        components.register(
            "lofu.glassButton",
            Rc::new(|cx| Box::new(GlassButton::new(cx))),
        );
        components.register(
            "lofu.searchField",
            Rc::new(|cx| Box::new(SearchField::new(cx))),
        );
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

    /// Calls `f` with the control when it sends one of `events`.
    unsafe fn on(control: &AnyObject, events: usize, f: impl Fn(&AnyObject) + 'static) {
        let handler = RcBlock::new(move |action: *mut AnyObject| {
            // SAFETY: UIKit passes the UIAction that ran.
            let sender: Option<Retained<AnyObject>> = unsafe { msg_send![action, sender] };
            if let Some(sender) = sender {
                f(&sender);
            }
        });
        unsafe {
            let action: Retained<AnyObject> =
                msg_send![class!(UIAction), actionWithHandler: &*handler];
            let _: () = msg_send![control, addAction: &*action, forControlEvents: events];
        }
    }

    /// The middle of `view` in its window, as nsh's `pagePosition`.
    unsafe fn page_position(view: &AnyObject) -> JsonValue {
        unsafe {
            let b: NSRect = msg_send![view, bounds];
            let p: NSPoint = msg_send![
                view,
                convertPoint: NSPoint::new(b.size.width / 2.0, b.size.height / 2.0),
                toView: Option::<&AnyObject>::None
            ];
            serde_json::json!({ "x": p.x, "y": p.y })
        }
    }

    struct GlassButton {
        button: Retained<UIView>,
        props: ButtonProps,
        cx: ComponentContext,
    }

    impl GlassButton {
        fn new(cx: ComponentContext) -> Self {
            // SAFETY: UIKit's own classes, on the main thread.
            unsafe {
                let button: Retained<UIView> = msg_send![class!(UIButton), buttonWithType: 0isize];
                let _: () = msg_send![&*button, setAutoresizingMask: FILL];
                let tap = cx.clone();
                on(&button, PRIMARY_ACTION, move |sender| {
                    tap.emit("tap", page_position(sender));
                });
                GlassButton {
                    button,
                    props: ButtonProps::default(),
                    cx,
                }
            }
        }

        unsafe fn apply(&self) {
            let p = &self.props;
            unsafe {
                let cls = class!(UIButtonConfiguration);
                let glass: bool =
                    msg_send![cls, respondsToSelector: sel!(glassButtonConfiguration)];
                let config: Retained<AnyObject> = match (p.variant(), glass) {
                    ("prominent", true) => msg_send![cls, prominentGlassButtonConfiguration],
                    ("prominent", false) => msg_send![cls, filledButtonConfiguration],
                    ("clear", true) => msg_send![cls, clearGlassButtonConfiguration],
                    ("plain", _) => msg_send![cls, plainButtonConfiguration],
                    (_, true) => msg_send![cls, glassButtonConfiguration],
                    (_, false) => msg_send![cls, grayButtonConfiguration],
                };
                if let Some(symbol) = &p.symbol {
                    let mut image: Option<Retained<AnyObject>> = msg_send![
                        class!(UIImage),
                        systemImageNamed: &*NSString::from_str(symbol)
                    ];
                    // The glass draws its symbol in the label's color whatever
                    // the tint; a tinted button draws an image of that color.
                    if let (Some(tint), Some(i)) = (p.tint, &image)
                        && p.variant() != "prominent"
                    {
                        // UIImageRenderingModeAlwaysOriginal
                        image = msg_send![&**i, imageWithTintColor: &*color(tint), renderingMode: 1isize];
                    }
                    let _: () = msg_send![&*config, setImage: image.as_deref()];
                    // UIImageSymbolWeight
                    let weight: isize = match p.weight.as_deref() {
                        Some("medium") => 5,
                        Some("semibold") => 6,
                        Some("bold") => 7,
                        _ => 4,
                    };
                    let symbols: Retained<AnyObject> = msg_send![
                        class!(UIImageSymbolConfiguration),
                        configurationWithPointSize: p.size.unwrap_or(17.0),
                        weight: weight
                    ];
                    let _: () =
                        msg_send![&*config, setPreferredSymbolConfigurationForImage: &*symbols];
                    let _: () = msg_send![&*config, setImagePadding: 6.0f64];
                }
                let title = p.title.as_deref().map(NSString::from_str);
                let _: () = msg_send![&*config, setTitle: title.as_deref()];
                // The prominent glass is filled with the button's tint; the
                // others draw their symbol and title in it.
                let tint = p.tint.map(|c| color(c));
                let _: () = msg_send![&*self.button, setTintColor: tint.as_deref()];
                if p.variant() != "prominent" {
                    let _: () = msg_send![&*config, setBaseForegroundColor: tint.as_deref()];
                }
                let _: () = msg_send![&*self.button, setConfiguration: &*config];
                let _: () = msg_send![&*self.button, setEnabled: !p.disabled];
                let label = p
                    .label
                    .as_deref()
                    .or(p.title.as_deref())
                    .map(NSString::from_str);
                let _: () = msg_send![&*self.button, setAccessibilityLabel: label.as_deref()];
                // Its own size, for a style that leaves it open (a labelled button).
                let size: NSSize = msg_send![&*self.button, intrinsicContentSize];
                self.cx.set_size(size.width as f32, size.height as f32);
            }
        }
    }

    impl NativeComponent for GlassButton {
        fn view(&self) -> &UIView {
            &self.button
        }

        fn set_prop(&mut self, name: &str, value: Option<&JsonValue>) {
            if self.props.set(name, value) {
                // SAFETY: on the main thread, with the button made in `new`.
                unsafe { self.apply() };
            }
        }
    }

    struct SearchField {
        root: Retained<UIView>,
        glass: Retained<AnyObject>,
        field: Retained<AnyObject>,
        glass_tint: Option<[f64; 4]>,
    }

    impl SearchField {
        fn new(cx: ComponentContext) -> Self {
            // SAFETY: UIKit's own classes, on the main thread.
            unsafe {
                // Subviews follow the root by their autoresizing masks, so
                // they're laid out once at a typical size and then follow.
                let frame = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(320.0, 48.0));
                let root: Retained<UIView> = msg_send![class!(UIView), new];
                let _: () = msg_send![&*root, setFrame: frame];
                let _: () = msg_send![&*root, setAutoresizingMask: FILL];

                let glass: Allocated<AnyObject> = msg_send![class!(UIVisualEffectView), alloc];
                let glass: Retained<AnyObject> = msg_send![
                    glass,
                    initWithEffect: Option::<&AnyObject>::None
                ];
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
                    let _: () = msg_send![&*layer, setCornerRadius: 24.0f64];
                }
                let _: () = msg_send![&*root, addSubview: &*glass];

                let field: Retained<AnyObject> = msg_send![class!(UISearchTextField), new];
                let _: () = msg_send![
                    &*field,
                    setFrame: NSRect::new(NSPoint::new(8.0, 0.0), NSSize::new(304.0, 48.0))
                ];
                let _: () = msg_send![&*field, setAutoresizingMask: FILL];
                // UITextBorderStyleNone: the glass is the field's background.
                let _: () = msg_send![&*field, setBorderStyle: 0isize];
                let clear: Retained<AnyObject> = msg_send![class!(UIColor), clearColor];
                let _: () = msg_send![&*field, setBackgroundColor: &*clear];
                let _: () = msg_send![&*field, setReturnKeyType: 6isize]; // UIReturnKeySearch
                let _: () = msg_send![&*field, setAutocapitalizationType: 0isize];
                let _: () = msg_send![&*field, setAutocorrectionType: 1isize]; // No
                let content: Retained<AnyObject> = msg_send![&*glass, contentView];
                let _: () = msg_send![&*content, addSubview: &*field];

                let emit = |cx: &ComponentContext, name: &'static str| {
                    let cx = cx.clone();
                    move |sender: &AnyObject| {
                        let text: Option<Retained<NSString>> = msg_send![sender, text];
                        let value = text.map(|t| t.to_string()).unwrap_or_default();
                        cx.emit(name, serde_json::json!({ "value": value }));
                    }
                };
                on(&field, EDITING_CHANGED, emit(&cx, "change"));
                on(&field, EDITING_ENDED_ON_EXIT, emit(&cx, "submit"));
                let began = cx.clone();
                on(&field, EDITING_BEGAN, move |_| {
                    began.emit("editing", serde_json::json!({ "focused": true }));
                });
                on(&field, EDITING_ENDED, move |_| {
                    cx.emit("editing", serde_json::json!({ "focused": false }));
                });

                let me = SearchField {
                    root,
                    glass,
                    field,
                    glass_tint: None,
                };
                me.apply_glass();
                me
            }
        }

        /// Interactive glass, tinted with `glass_tint`; a blur before iOS 26.
        unsafe fn apply_glass(&self) {
            unsafe {
                let effect: Retained<AnyObject> = match AnyClass::get(c"UIGlassEffect") {
                    Some(cls) => {
                        let effect: Retained<AnyObject> = msg_send![cls, effectWithStyle: 0isize];
                        let _: () = msg_send![&*effect, setInteractive: true];
                        if let Some(tint) = self.glass_tint {
                            let _: () = msg_send![&*effect, setTintColor: &*color(tint)];
                        }
                        effect
                    }
                    // UIBlurEffectStyleSystemMaterial
                    None => msg_send![class!(UIBlurEffect), effectWithStyle: 8isize],
                };
                let _: () = msg_send![&*self.glass, setEffect: &*effect];
            }
        }
    }

    impl NativeComponent for SearchField {
        fn view(&self) -> &UIView {
            &self.root
        }

        fn set_prop(&mut self, name: &str, value: Option<&JsonValue>) {
            let field = &*self.field;
            // SAFETY: on the main thread, with the views made in `new`.
            unsafe {
                match name {
                    "value" => {
                        let value = value.and_then(JsonValue::as_str).unwrap_or("");
                        let now: Option<Retained<NSString>> = msg_send![field, text];
                        // Only when it differs: setting the text moves the caret to its end.
                        if now.map(|t| t.to_string()).unwrap_or_default() != value {
                            let _: () = msg_send![field, setText: &*NSString::from_str(value)];
                        }
                    }
                    "placeholder" => {
                        let text = string(value).map(|s| NSString::from_str(&s));
                        let _: () = msg_send![field, setPlaceholder: text.as_deref()];
                    }
                    "fontSize" => {
                        let font: Retained<AnyObject> = msg_send![
                            class!(UIFont),
                            systemFontOfSize: number(value).unwrap_or(17.0)
                        ];
                        let _: () = msg_send![field, setFont: &*font];
                    }
                    "tint" => {
                        let tint = parse_color(value).map(|c| color(c));
                        let _: () = msg_send![field, setTintColor: tint.as_deref()];
                    }
                    "textColor" => {
                        let ink = parse_color(value).map(|c| color(c));
                        let _: () = msg_send![field, setTextColor: ink.as_deref()];
                    }
                    "glassTint" => {
                        self.glass_tint = parse_color(value);
                        self.apply_glass();
                    }
                    "label" => {
                        let text = string(value).map(|s| NSString::from_str(&s));
                        let _: () = msg_send![field, setAccessibilityLabel: text.as_deref()];
                    }
                    "autoFocus" if boolean(value, false) => {
                        let _: bool = msg_send![field, becomeFirstResponder];
                    }
                    _ => {}
                }
            }
        }

        fn command(&mut self, name: &str, _args: &JsonValue) {
            // SAFETY: on the main thread, with the field made in `new`.
            unsafe {
                match name {
                    "focus" => {
                        let _: bool = msg_send![&*self.field, becomeFirstResponder];
                    }
                    "blur" => {
                        let _: bool = msg_send![&*self.field, resignFirstResponder];
                    }
                    _ => {}
                }
            }
        }
    }
}

#[cfg(target_os = "macos")]
pub mod macos {
    use std::rc::Rc;

    use nsh_core::JsonValue;
    use nsh_platform_macos::{ComponentContext, Components, NativeComponent};
    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, NSObject, NSObjectProtocol};
    use objc2::{
        DefinedClass, MainThreadMarker, MainThreadOnly, class, define_class, msg_send, sel,
    };
    use objc2_app_kit::NSView;
    use objc2_foundation::{NSArray, NSPoint, NSRect, NSString};

    use super::ButtonProps;

    // NSAutoresizingMaskOptions
    const MIN_X: usize = 1;
    const MAX_X: usize = 4;
    const MIN_Y: usize = 8;
    const MAX_Y: usize = 32;

    pub fn register(components: &Components) {
        components.register(
            "lofu.glassButton",
            Rc::new(|cx| Box::new(GlassButton::new(cx))),
        );
    }

    /// What a control's action reports: the control that sent it.
    type Handler = Box<dyn Fn(&AnyObject)>;

    define_class!(
        /// The target of a control: AppKit's controls report to an object,
        /// not a closure.
        #[unsafe(super(NSObject))]
        #[thread_kind = MainThreadOnly]
        #[name = "LofuControlTarget"]
        #[ivars = Handler]
        struct Target;

        impl Target {
            #[unsafe(method(fire:))]
            fn fire(&self, sender: &AnyObject) {
                (self.ivars())(sender);
            }
        }

        unsafe impl NSObjectProtocol for Target {}
    );

    impl Target {
        fn new(mtm: MainThreadMarker, handler: Handler) -> Retained<Self> {
            let this = Self::alloc(mtm).set_ivars(handler);
            // SAFETY: NSObject's designated initializer.
            unsafe { msg_send![super(this), init] }
        }
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

    /// The middle of `view` from its window's top left, as nsh's `pagePosition`.
    unsafe fn page_position(view: &AnyObject) -> JsonValue {
        unsafe {
            let b: NSRect = msg_send![view, bounds];
            let r: NSRect = msg_send![view, convertRect: b, toView: Option::<&AnyObject>::None];
            let window: Option<Retained<AnyObject>> = msg_send![view, window];
            let height = window
                .and_then(|w| {
                    let content: Option<Retained<AnyObject>> = msg_send![&*w, contentView];
                    content
                })
                .map(|c| {
                    let f: NSRect = msg_send![&*c, frame];
                    f.size.height
                })
                .unwrap_or(0.0);
            serde_json::json!({
                "x": r.origin.x + r.size.width / 2.0,
                "y": height - (r.origin.y + r.size.height / 2.0),
            })
        }
    }

    fn mtm() -> MainThreadMarker {
        MainThreadMarker::new().expect("native components are made on the main thread")
    }

    struct GlassButton {
        root: Retained<NSView>,
        button: Retained<AnyObject>,
        _target: Retained<Target>,
        props: ButtonProps,
        cx: ComponentContext,
    }

    impl GlassButton {
        fn new(cx: ComponentContext) -> Self {
            let tap = cx.clone();
            let target = Target::new(
                mtm(),
                Box::new(move |sender| {
                    // SAFETY: the button that sent its action.
                    tap.emit("tap", unsafe { page_position(sender) });
                }),
            );
            // SAFETY: AppKit's own classes, on the main thread.
            unsafe {
                let root: Retained<NSView> = msg_send![class!(NSView), new];
                let button: Retained<AnyObject> = msg_send![class!(NSButton), new];
                let _: () = msg_send![&*button, setTarget: &*target];
                let _: () = msg_send![&*button, setAction: sel!(fire:)];
                let _: () = msg_send![&*root, addSubview: &*button];
                GlassButton {
                    root,
                    button,
                    _target: target,
                    props: ButtonProps::default(),
                    cx,
                }
            }
        }

        unsafe fn apply(&self) {
            let p = &self.props;
            let b = &*self.button;
            unsafe {
                let glass: bool = msg_send![b, respondsToSelector: sel!(setBorderShape:)];
                let plain = p.variant() == "plain";
                let _: () = msg_send![b, setBordered: !plain];
                if !plain {
                    // NSBezelStyleGlass on macOS 26, else the push button's.
                    let _: () = msg_send![b, setBezelStyle: if glass { 16usize } else { 1usize }];
                }
                // NSControlSize: regular, large, or by default extra large on
                // macOS 26 (a toolbar's), else large.
                let size: usize = match p.control_size.as_deref() {
                    Some("regular") => 0,
                    Some("large") => 3,
                    _ if glass => 4,
                    _ => 3,
                };
                let _: () = msg_send![b, setControlSize: size];
                let title = NSString::from_str(p.title.as_deref().unwrap_or(""));
                let _: () = msg_send![b, setTitle: &*title];
                if let Some(symbol) = &p.symbol {
                    let label = p.label.as_deref().map(NSString::from_str);
                    let image: Option<Retained<AnyObject>> = msg_send![
                        class!(NSImage),
                        imageWithSystemSymbolName: &*NSString::from_str(symbol),
                        accessibilityDescription: label.as_deref()
                    ];
                    let _: () = msg_send![b, setImage: image.as_deref()];
                    // NSFontWeight
                    let weight: f64 = match p.weight.as_deref() {
                        Some("medium") => 0.23,
                        Some("semibold") => 0.3,
                        Some("bold") => 0.4,
                        _ => 0.0,
                    };
                    let mut symbols: Retained<AnyObject> = msg_send![
                        class!(NSImageSymbolConfiguration),
                        configurationWithPointSize: p.size.unwrap_or(15.0),
                        weight: weight
                    ];
                    // The glass bezel draws its symbol in the label's color
                    // whatever `contentTintColor` says: color the symbol.
                    if let Some(tint) = p.tint {
                        let colors = NSArray::from_retained_slice(&[color(tint)]);
                        let palette: Retained<AnyObject> = msg_send![
                            class!(NSImageSymbolConfiguration),
                            configurationWithPaletteColors: &*colors
                        ];
                        symbols = msg_send![
                            &*symbols,
                            configurationByApplyingConfiguration: &*palette
                        ];
                    }
                    let _: () = msg_send![b, setSymbolConfiguration: &*symbols];
                    // NSImageOnly, else NSImageLeading
                    let position: usize = if p.title.is_some() { 7 } else { 1 };
                    let _: () = msg_send![b, setImagePosition: position];
                }
                if glass {
                    // NSControlBorderShapeCircle for a symbol alone, else a capsule.
                    let shape: isize = if p.title.is_none() { 3 } else { 1 };
                    let _: () = msg_send![b, setBorderShape: shape];
                }
                // AppKit's glass bezel draws in the window's accent, not a
                // bezel color of the app's: a prominent button shows its
                // symbol and title in the tint instead, as the others do.
                let tint = p.tint.map(|c| color(c));
                let _: () = msg_send![b, setContentTintColor: tint.as_deref()];
                let _: () = msg_send![b, setEnabled: !p.disabled];
                let label = p
                    .label
                    .as_deref()
                    .or(p.title.as_deref())
                    .map(NSString::from_str);
                let _: () = msg_send![b, setAccessibilityLabel: label.as_deref()];
                let _: () = msg_send![b, setToolTip: label.as_deref()];
                self.center();
            }
        }

        /// The button at its own size, in the middle of the root, and kept there.
        unsafe fn center(&self) {
            unsafe {
                let _: () = msg_send![&*self.button, sizeToFit];
                let frame: NSRect = msg_send![&*self.button, frame];
                let size = frame.size;
                self.cx.set_size(size.width as f32, size.height as f32);
                let root: NSRect = msg_send![&*self.root, bounds];
                let origin = NSPoint::new(
                    ((root.size.width - size.width) / 2.0).round(),
                    ((root.size.height - size.height) / 2.0).round(),
                );
                let _: () = msg_send![&*self.button, setFrame: NSRect::new(origin, size)];
                let _: () = msg_send![
                    &*self.button,
                    setAutoresizingMask: MIN_X | MAX_X | MIN_Y | MAX_Y
                ];
            }
        }
    }

    impl NativeComponent for GlassButton {
        fn view(&self) -> Retained<NSView> {
            self.root.clone()
        }

        fn set_prop(&mut self, name: &str, value: Option<&JsonValue>) {
            if self.props.set(name, value) {
                // SAFETY: on the main thread, with the button made in `new`.
                unsafe { self.apply() };
            }
        }
    }
}
