import { type InputRef, type JSX, View, type ViewRef } from "nsh";
import { Input } from "nsh/base";
import { glass, look } from "../lib/look";
import { NativeSearchField, nativeSearchField } from "./native";
import { GlassTint, Icon } from "./ui";

/**
 * A search field on a capsule of glass, as iOS 26 and macOS 26 draw theirs:
 * the system's own on iOS (`UISearchTextField` on interactive glass, left
 * untinted as the system's search bars are, so it stays clear over the
 * page), and the app's look-alike elsewhere (see `nativeSearchField`).
 */
export function SearchField(props: {
  value: () => string;
  onChange: (v: string) => void;
  placeholder: string;
  height?: number;
  autoFocus?: boolean;
  testID?: string;
  /** Return on the keyboard. */
  onSubmit?: (v: string) => void;
  /** The app's own field (not the system's): for focusing it from a shortcut. */
  inputRef?: (r: InputRef) => void;
  /** The capsule (the app's own field): what suggestions are placed under. */
  boxRef?: (r: ViewRef) => void;
  onFocus?: () => void;
  onBlur?: () => void;
  /** Before the clear button (the app's own field): the filter button. */
  trailing?: JSX.Element;
}) {
  const big = (props.height ?? 0) > 40;
  if (nativeSearchField) {
    return (
      <NativeSearchField
        testID={props.testID ?? "search"}
        accessibilityLabel={props.placeholder}
        value={props.value()}
        placeholder={props.placeholder}
        fontSize={big ? 17 : 14}
        tint={look().stamp}
        textColor={look().ink}
        label={props.placeholder}
        autoFocus={props.autoFocus ?? false}
        onChange={(e) => props.onChange(e.value)}
        onSubmit={(e) => props.onSubmit?.(e.value)}
        style={{ height: props.height ?? 40 }}
      />
    );
  }
  return (
    <View
      ref={(r) => props.boxRef?.(r)}
      class={`flex-row items-center rounded-full ${big ? "gap-2.5 px-4" : "gap-2 px-3.5"}`}
      style={{ ...glass(), borderCurve: "continuous", height: props.height ?? 40 }}
    >
      <GlassTint />
      <Icon name="search" size={big ? 17 : 14} color={look().inkSoft} />
      <Input
        testID={props.testID ?? "search"}
        ref={(r) => props.inputRef?.(r)}
        autoFocus={props.autoFocus}
        value={props.value()}
        placeholder={props.placeholder}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        onChange={({ value }) => props.onChange(value)}
        onSubmit={({ text }) => props.onSubmit?.(text)}
        onFocus={() => props.onFocus?.()}
        onBlur={() => props.onBlur?.()}
        class="flex-1"
        style={{
          color: look().ink,
          fontSize: big ? 17 : 13.5,
          placeholderColor: look().inkFaint,
        }}
      />
      {props.trailing}
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
