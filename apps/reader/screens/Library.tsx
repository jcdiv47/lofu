import { Scroll, signal, Text, View } from "nsh";
import { api, type Bookmark } from "../lib/api";
import { look } from "../lib/look";

export function Library(props: { onOpen: (b: Bookmark) => void; onSettings: () => void }) {
  const items = signal<Bookmark[] | null>(null);
  const error = signal("");
  (async () => {
    try {
      items.set((await api.library()).filter((b) => b.contentStatus === "ok"));
    } catch (e) {
      error.set((e as Error).message);
    }
  })();

  return (
    <View class="flex-1" style={{ backgroundColor: look().paper }}>
      <View
        class="flex-row items-end justify-between px-5 pt-4 pb-3"
        style={{ borderBottomWidth: 1, borderColor: look().stamp }}
      >
        <Text style={{ color: look().ink, fontSize: 30, fontStyle: "italic", fontFamily: "serif" }}>
          lofu
        </Text>
        <View onPress={props.onSettings} role="button" class="pb-1 active:opacity-60">
          <Text style={{ color: look().inkSoft, fontSize: 14 }}>Settings</Text>
        </View>
      </View>
      <If
        when={!error()}
        else={
          <Text class="p-6" style={{ color: look().stamp }}>
            {error()}
          </Text>
        }
      >
        <Scroll class="flex-1">
          <Each of={items() ?? []} key={(b) => b.id}>
            {(b) => (
              <View
                onPress={() => props.onOpen(b())}
                role="button"
                class="px-5 py-4 active:opacity-60"
                style={{ borderBottomWidth: 1, borderColor: look().rule }}
              >
                <Text
                  class="line-clamp-2"
                  style={{ color: look().ink, fontSize: 19, lineHeight: 24, fontFamily: "serif" }}
                >
                  {b().title || b().url}
                </Text>
                <Text
                  style={{
                    color: look().inkFaint,
                    fontSize: 12,
                    marginTop: 4,
                    fontFamily: "monospace",
                  }}
                >
                  {b().domain}
                  {b().wordCount ? ` · ${b().wordCount} words` : ""}
                </Text>
              </View>
            )}
          </Each>
        </Scroll>
      </If>
    </View>
  );
}
