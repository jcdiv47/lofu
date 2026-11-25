import { type Bounds, computed, Overlay, Scroll, Text, View, type ViewRef } from "nsh";
import { look } from "../lib/look";
import type { SuggestRow, SuggestSection } from "../lib/search";
import { focusRing, Icon } from "./ui";

/** A section's rows, each with its place counting through the sections (the arrow keys'). */
type Indexed = Omit<SuggestSection, "rows"> & {
  key: string;
  rows: { row: SuggestRow; index: number }[];
};

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
  // Each row's place, worked out once per change of the sections, not
  // looked up in the whole list by every row.
  const sections = computed((): Indexed[] => {
    let k = 0;
    return props.sections().map((s, si) => ({
      ...s,
      key: `${si}:${s.title ?? ""}`,
      rows: s.rows.map((row) => ({ row, index: k++ })),
    }));
  });
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
        class="overflow-hidden rounded-xl border border-rule bg-card-hover"
        style={{ width: props.width ?? 380, boxShadow: look().popupShadow }}
      >
        <Scroll style={{ maxHeight: 460 }} contentClass="p-1.5">
          <Each of={sections()} key={(s) => s.key}>
            {(s, si) => (
              <View class={si() > 0 ? "mt-1.5" : ""}>
                <If when={si() > 0 && !s().title}>
                  <View class="mx-2 mb-1.5 h-px bg-rule-soft" />
                </If>
                <If when={s().title}>
                  <Text class="px-2.5 pt-1 pb-1 text-ink-faint" style={{ fontSize: 12 }}>
                    {s().title}
                  </Text>
                </If>
                <If when={s().help}>
                  <Text
                    class="px-2.5 pt-1 pb-2 text-ink-faint"
                    style={{ fontSize: 12.5, lineHeight: 17 }}
                  >
                    {s().help}
                  </Text>
                </If>
                <Each of={s().rows} key={(r) => r.row.key}>
                  {(r) => (
                    <View
                      role="button"
                      accessibilityLabel={
                        r().row.detail ? `${r().row.label}, ${r().row.detail}` : r().row.label
                      }
                      accessibilityState={{ selected: r().index === props.active() }}
                      testID={`suggest-${r().row.key}`}
                      class={`flex-row items-center gap-2.5 rounded-md px-2.5 hover:bg-selected ${focusRing} ${
                        r().index === props.active() ? "bg-selected" : ""
                      }`}
                      style={{ height: 32 }}
                      onMouseEnter={() => props.onActive(r().index)}
                      onPress={() => props.onPick(r().row)}
                    >
                      <Icon name={r().row.icon} size={15} color={r().row.tint} />
                      <Text class="min-w-0 flex-1 truncate text-ink" style={{ fontSize: 13.5 }}>
                        {r().row.label}
                      </Text>
                      <If when={r().row.detail}>
                        <Text
                          class="text-ink-faint"
                          style={{ fontSize: 12, fontVariant: ["tabular-nums"] }}
                        >
                          {r().row.detail}
                        </Text>
                      </If>
                      <If when={r().row.enter}>
                        <Icon name="enter" size={13} class="tint-ink-faint" />
                      </If>
                    </View>
                  )}
                </Each>
              </View>
            )}
          </Each>
        </Scroll>
        <View class="flex-row items-center border-t border-rule-soft px-4 py-2.5">
          <Text class="flex-1 text-ink-faint" style={{ fontSize: 12, lineHeight: 16 }}>
            Put - (dash) in front of a condition you want to exclude from search
          </Text>
        </View>
      </View>
    </Overlay>
  );
}
