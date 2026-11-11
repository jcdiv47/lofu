import {
  cleanup,
  effect,
  type InputRef,
  keymap,
  Scroll,
  type Signal,
  signal,
  Text,
  View,
} from "nsh";
import { Input } from "nsh/base";
import { look } from "../lib/look";
import { tags as allTags } from "../lib/store";
import { Icon } from "./ui";

/** What separates tags as they're typed or pasted (a tag may have spaces). */
const SEPARATOR = /[,，\n]/;

/** A tag as stored: trimmed and lowercased. */
export const normalizeTag = (t: string) => t.trim().toLowerCase();

type Pill = { key: string; name: string; label: string; count?: number; create?: boolean };

/** Pills shown before "+N more": about two lines in the dialog. */
const FOLDED = 12;

/**
 * Tags as chips with an input after them, and under it the tags in use as
 * pills, most used first, that a press adds. Typing narrows the pills (those
 * that start with what's typed first, then those that contain it) and offers
 * to create a new tag; Return or a comma adds it, Backspace in the empty
 * input takes the last chip off, and a chip's × removes it. The arrow keys
 * move through the pills. Return with nothing typed is `onSubmit`. A long
 * list folds after a dozen behind "+N more", and scrolls once unfolded.
 */
export function TagField(props: {
  value: Signal<string[]>;
  /** What hasn't been made a chip yet (the owner adds it when saving). */
  query: Signal<string>;
  onSubmit?: () => void;
  testID?: string;
  placeholder?: string;
}) {
  const focused = signal(false);
  const active = signal(-1);
  const unfolded = signal(false);
  let input: InputRef | undefined;

  const add = (names: string[]) => {
    const next = [...props.value()];
    for (const n of names.map(normalizeTag)) if (n && !next.includes(n)) next.push(n);
    props.value.set(next);
  };
  const remove = (name: string) => props.value.set(props.value().filter((t) => t !== name));

  /** The tags in use that aren't chips yet and match what's typed. */
  const matches = () => {
    const typed = normalizeTag(props.query());
    const have = new Set(props.value());
    const unused = allTags().filter((t) => !have.has(t.name));
    if (!typed) return unused;
    return [
      ...unused.filter((t) => t.name.startsWith(typed)),
      ...unused.filter((t) => !t.name.startsWith(typed) && t.name.includes(typed)),
    ];
  };
  const hidden = () => (unfolded() ? 0 : Math.max(0, matches().length - FOLDED));

  const pills = (): Pill[] => {
    const all = matches();
    const out: Pill[] = (unfolded() ? all : all.slice(0, FOLDED)).map((t) => ({
      key: t.name,
      name: t.name,
      label: `#${t.name}`,
      count: t.count,
    }));
    const typed = normalizeTag(props.query());
    if (typed && !props.value().includes(typed) && !all.some((t) => t.name === typed)) {
      out.push({ key: "+new", name: typed, label: `Create “${typed}”`, create: true });
    }
    return out;
  };

  // Typing lights the first suggestion, so Return takes it; with nothing
  // typed, Return saves unless an arrow key picked a row.
  effect(() => {
    active.set(props.query().trim() ? 0 : -1);
  });

  const pick = (pill: Pill) => {
    add([pill.name]);
    props.query.set("");
    input?.focus();
  };

  // A press on a pill takes the keyboard from the input first; wait for it
  // before taking the field's focus look off. Typing counts as focus too: the Mac reports
  // a blur when a chip goes while the input keeps the keyboard.
  let blurTimer: ReturnType<typeof setTimeout> | undefined;
  const onFocus = () => {
    if (blurTimer) clearTimeout(blurTimer);
    focused.set(true);
  };
  const onBlur = () => {
    if (blurTimer) clearTimeout(blurTimer);
    blurTimer = setTimeout(() => focused.set(false), 200);
  };
  cleanup(() => blurTimer && clearTimeout(blurTimer));

  const onChange = (v: string) => {
    onFocus();
    if (!SEPARATOR.test(v)) {
      props.query.set(v);
      return;
    }
    const parts = v.split(SEPARATOR);
    const rest = parts.pop() ?? "";
    add(parts);
    props.query.set(rest.trimStart());
  };

  const onSubmit = () => {
    const pill = pills()[active()];
    if (pill) return pick(pill);
    if (props.query().trim()) {
      add([props.query()]);
      props.query.set("");
      return;
    }
    props.onSubmit?.();
  };

  const move = (by: number) => {
    const n = pills().length;
    if (!n) return;
    const i = active();
    active.set(i < 0 ? (by > 0 ? 0 : n - 1) : (i + by + n) % n);
  };

  effect(() => {
    if (!focused() || !pills().length) return;
    const off = keymap.bind(
      {
        up: () => move(-1),
        down: () => move(1),
        escape: () => {
          if (props.query()) props.query.set("");
          else input?.blur();
        },
      },
      { when: "always", repeat: true },
    );
    cleanup(off);
  });

  return (
    <View class="gap-1.5">
      <View
        focusable={false}
        onPress={() => input?.focus()}
        class="min-h-10 flex-row flex-wrap items-center gap-1.5 rounded-xl py-1.5 pr-2 pl-1.5"
        style={{
          backgroundColor: look().card,
          borderWidth: 1,
          borderColor: focused() ? look().inkFaint : look().rule,
        }}
      >
        <Each of={props.value()}>
          {(t) => (
            <View
              testID={`tag-chip-${t()}`}
              class="flex-row items-center gap-1 rounded-full py-1 pr-1 pl-2.5"
              style={{ backgroundColor: look().field, maxWidth: 260 }}
            >
              <Text class="shrink truncate" style={{ color: look().ink, fontSize: 13 }}>
                #{t()}
              </Text>
              <View
                role="button"
                accessibilityLabel={`Remove tag ${t()}`}
                focusable={false}
                onPress={() => remove(t())}
                class="h-4.5 w-4.5 items-center justify-center rounded-full active:opacity-60"
                hoverStyle={{ backgroundColor: look().selected }}
              >
                <Icon name="close" size={9} color={look().inkSoft} />
              </View>
            </View>
          )}
        </Each>
        <Input
          testID={props.testID}
          ref={(r) => {
            input = r;
          }}
          value={props.query()}
          placeholder={props.placeholder ?? "Add a tag…"}
          autoCapitalize="none"
          autoCorrect={false}
          submitBehavior="submit"
          returnKeyType="done"
          onChange={({ value }) => onChange(value)}
          onSubmit={onSubmit}
          onKeyPress={({ key }) => {
            onFocus();
            const last = props.value().at(-1);
            if (key === "Backspace" && !props.query() && last) remove(last);
          }}
          onFocus={onFocus}
          onBlur={onBlur}
          class="min-w-30 flex-1 px-1.5"
          style={{ height: 28, color: look().ink, fontSize: 15, placeholderColor: look().inkFaint }}
        />
      </View>
      <If when={pills().length || hidden()}>
        <Scroll
          testID="tag-suggestions"
          style={{ maxHeight: unfolded() ? 168 : undefined }}
          contentClass="flex-row flex-wrap gap-1.5"
        >
          {pills().map((pill, i) => (
            <View
              role="button"
              testID={`tag-suggest-${pill.key}`}
              accessibilityLabel={pill.count ? `Add ${pill.label}, ${pill.count}` : pill.label}
              focusable={false}
              onPress={() => pick(pill)}
              class="flex-row items-center gap-1.5 rounded-full px-2.5 py-1 active:opacity-60"
              style={{
                borderWidth: 1,
                borderColor: i === active() ? look().inkFaint : look().rule,
                borderStyle: pill.create ? "dashed" : "solid",
                maxWidth: 260,
                backgroundColor: i === active() ? look().selected : undefined,
              }}
              hoverStyle={{ backgroundColor: look().selected }}
            >
              <If when={pill.create}>
                <Icon name="plus" size={10} color={look().inkSoft} />
              </If>
              <Text class="shrink truncate" style={{ color: look().inkSoft, fontSize: 12.5 }}>
                {pill.label}
              </Text>
              <If when={pill.count}>
                <Text
                  style={{ color: look().inkFaint, fontSize: 11, fontVariant: ["tabular-nums"] }}
                >
                  {pill.count}
                </Text>
              </If>
            </View>
          ))}
          <If when={hidden() || (unfolded() && matches().length > FOLDED)}>
            <View
              role="button"
              testID="tag-suggest-more"
              focusable={false}
              onPress={() => unfolded.set(!unfolded())}
              class="rounded-full px-2.5 py-1 active:opacity-60"
              hoverStyle={{ backgroundColor: look().selected }}
            >
              <Text style={{ color: look().inkFaint, fontSize: 12.5, fontWeight: "500" }}>
                {unfolded() ? "Show fewer" : `+${hidden()} more`}
              </Text>
            </View>
          </If>
        </Scroll>
      </If>
    </View>
  );
}
