import { View } from "nsh";
import { Input } from "nsh/base";
import { glass, look } from "../lib/look";
import { GlassTint, Icon } from "./ui";

/** A search field on a capsule of glass, as iOS 26 and macOS 26 draw theirs. */
export function SearchField(props: {
  value: () => string;
  onChange: (v: string) => void;
  placeholder: string;
  height?: number;
  autoFocus?: boolean;
  testID?: string;
  /** Return on the keyboard. */
  onSubmit?: (v: string) => void;
}) {
  const big = (props.height ?? 0) > 40;
  return (
    <View
      class={`flex-row items-center rounded-full ${big ? "gap-2.5 px-4" : "gap-2 px-3.5"}`}
      style={{ ...glass(), borderCurve: "continuous", height: props.height ?? 40 }}
    >
      <GlassTint />
      <Icon name="search" size={big ? 17 : 14} color={look().inkSoft} />
      <Input
        testID={props.testID ?? "search"}
        autoFocus={props.autoFocus}
        value={props.value()}
        placeholder={props.placeholder}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        onChange={({ value }) => props.onChange(value)}
        onSubmit={({ text }) => props.onSubmit?.(text)}
        class="flex-1"
        style={{
          color: look().ink,
          fontSize: big ? 17 : 13.5,
          placeholderColor: look().inkFaint,
        }}
      />
      <If when={props.value()}>
        <View
          role="button"
          accessibilityLabel="Clear search"
          onPress={() => props.onChange("")}
          class={`items-center justify-center rounded-full active:opacity-60 ${big ? "h-6 w-6" : "h-5 w-5"}`}
          style={{ backgroundColor: look().inkFaint }}
        >
          <Icon name="close" size={11} color={look().field} />
        </View>
      </If>
    </View>
  );
}
