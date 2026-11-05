import { mount, signal, View } from "nsh";
import type { Bookmark } from "./lib/api";
import { loadSettings } from "./lib/api";
import { look } from "./lib/look";
import { Library } from "./screens/Library";
import { Reader } from "./screens/Reader";
import { Settings } from "./screens/Settings";

type Screen = { name: "library" } | { name: "reader"; bookmark: Bookmark } | { name: "settings" };

function App() {
  const screen = signal<Screen | null>(null);
  void loadSettings().then((s) =>
    screen.set(s.server && s.token ? { name: "library" } : { name: "settings" }),
  );

  return (
    <View
      class="flex-1 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]"
      style={{ backgroundColor: look().paper }}
    >
      {() => {
        const s = screen();
        if (!s) return null;
        if (s.name === "settings")
          return <Settings onDone={() => screen.set({ name: "library" })} />;
        if (s.name === "reader") {
          return <Reader bookmark={s.bookmark} onBack={() => screen.set({ name: "library" })} />;
        }
        return (
          <Library
            onOpen={(bookmark) => screen.set({ name: "reader", bookmark })}
            onSettings={() => screen.set({ name: "settings" })}
          />
        );
      }}
    </View>
  );
}

mount(App);
