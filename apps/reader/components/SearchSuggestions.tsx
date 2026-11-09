import { type Bounds, Overlay, Scroll, Text, View, type ViewRef } from "nsh";
import { look } from "../lib/look";
import type { SuggestRow, SuggestSection } from "../lib/search";
import { Icon } from "./ui";

/**
 * The panel under the search box (Raindrop's): sections of rows, each an
 * icon, a name and a count, time or place on the right; the row the arrow
 * keys are on is lit, and under them the reminder that `-` excludes.
 */
export function SearchSuggestions(props: {
  /** The search field (the web), or its frame in the window (the Mac's toolbar). */
  anchor: () => ViewRef | Bounds | null;
  sections: () => SuggestSection[];
  /** Which row is lit, counting through the sections; -1 for none. */
  active: () => number;
  onActive: (i: number) => void;
  onPick: (row: SuggestRow) => void;
  onClose: () => void;
  width?: number;
}) {
  const rows = () => props.sections().flatMap((s) => s.rows);
  const indexOf = (row: SuggestRow) => rows().indexOf(row);
  return (
    <Overlay
      anchor={props.anchor()}
      placement="bottom"
      align="end"
      offset={6}
      margin={10}
      onPressOutside={() => props.onClose()}
      onCancel={() => props.onClose()}
    >
      <View
        testID="search-suggestions"
        class="overflow-hidden rounded-xl"
        style={{
          width: props.width ?? 380,
          backgroundColor: look().cardHover,
          borderWidth: 1,
          borderColor: look().rule,
          boxShadow: "0px 2px 6px rgb(0 0 0 / 0.12), 0px 12px 32px rgb(0 0 0 / 0.22)",
        }}
      >
        <Scroll style={{ maxHeight: 460 }} contentClass="p-1.5">
          {props.sections().map((s, si) => (
            <View class={si > 0 ? "mt-1.5" : ""}>
              <If when={si > 0 && !s.title}>
                <View class="mx-2 mb-1.5 h-px" style={{ backgroundColor: look().ruleSoft }} />
              </If>
              <If when={s.title}>
                <Text class="px-2.5 pt-1 pb-1" style={{ color: look().inkFaint, fontSize: 12 }}>
                  {s.title}
                </Text>
              </If>
              <If when={s.help}>
                <Text
                  class="px-2.5 pt-1 pb-2"
                  style={{ color: look().inkFaint, fontSize: 12.5, lineHeight: 17 }}
                >
                  {s.help}
                </Text>
              </If>
              {s.rows.map((row) => (
                <View
                  role="button"
                  accessibilityLabel={row.detail ? `${row.label}, ${row.detail}` : row.label}
                  testID={`suggest-${row.key}`}
                  class="flex-row items-center gap-2.5 rounded-md px-2.5"
                  style={{
                    height: 32,
                    backgroundColor: indexOf(row) === props.active() ? look().selected : undefined,
                  }}
                  hoverStyle={{ backgroundColor: look().selected }}
                  onMouseEnter={() => props.onActive(indexOf(row))}
                  onPress={() => props.onPick(row)}
                >
                  <Icon name={row.icon} size={15} color={row.tint ?? look().inkSoft} />
                  <Text
                    class="min-w-0 flex-1 truncate"
                    style={{ color: look().ink, fontSize: 13.5 }}
                  >
                    {row.label}
                  </Text>
                  <If when={row.detail}>
                    <Text
                      style={{
                        color: look().inkFaint,
                        fontSize: 12,
                        fontVariant: ["tabular-nums"],
                      }}
                    >
                      {row.detail}
                    </Text>
                  </If>
                  <If when={row.enter}>
                    <Icon name="enter" size={13} color={look().inkFaint} />
                  </If>
                </View>
              ))}
            </View>
          ))}
        </Scroll>
        <View
          class="flex-row items-center px-4 py-2.5"
          style={{ borderTopWidth: 1, borderColor: look().ruleSoft }}
        >
          <Text class="flex-1" style={{ color: look().inkFaint, fontSize: 12, lineHeight: 16 }}>
            Put - (dash) in front of a condition you want to exclude from search
          </Text>
        </View>
      </View>
    </Overlay>
  );
}
