import { keyboardFrame, safeArea, signal, Text, View } from "nsh";
import { Input } from "nsh/base";
import { glass, look } from "../lib/look";
import { GlassButton, GlassTint } from "./ui";

/**
 * Asks for a line of text (a new name): a small card of glass over the app,
 * above the keyboard. nsh's `AlertDialog` takes no text, hence this.
 * `run` does the work and may throw: its message shows on the card, which
 * stays open; resolves with whether it was done.
 */
interface Ask {
  title: string;
  value: string;
  placeholder: string;
  confirm: string;
  run: (text: string) => Promise<void>;
  done: (ok: boolean) => void;
}

const asking = signal<Ask | null>(null);

export function promptText(opts: Omit<Ask, "done">): Promise<boolean> {
  asking()?.done(false);
  return new Promise((done) => asking.set({ ...opts, done }));
}

/** Mounted once, over everything else (`App.tsx`). */
export function PromptHost() {
  return <If when={asking()}>{(a) => <PromptCard ask={a()} />}</If>;
}

function PromptCard(props: { ask: Ask }) {
  const text = signal(props.ask.value);
  const busy = signal(false);
  const error = signal("");
  const close = (ok: boolean) => {
    asking.set(null);
    props.ask.done(ok);
  };
  const submit = async () => {
    if (!text().trim() || busy()) return;
    busy.set(true);
    error.set("");
    try {
      await props.ask.run(text().trim());
      close(true);
    } catch (e) {
      error.set((e as Error).message);
      busy.set(false);
    }
  };
  /** Over the keyboard on phones; a third of the way down elsewhere. */
  const top = () =>
    keyboardFrame().height > 0
      ? Math.max(safeArea().top + 16, 80)
      : Math.max(safeArea().top + 80, 140);
  return (
    <View class="absolute inset-0" style={{ zIndex: 100 }}>
      <View
        class="absolute inset-0"
        onPress={() => close(false)}
        style={{ backgroundColor: "#00000040" }}
      />
      <View class="absolute right-0 left-0 items-center px-5" style={{ top: top() }}>
        <View
          testID="prompt-card"
          class="w-full gap-4 overflow-hidden rounded-[26px] p-5"
          style={{ ...glass(), borderCurve: "continuous", maxWidth: 420 }}
        >
          <GlassTint radius={26} />
          <Text class="text-center" style={{ color: look().ink, fontSize: 17, fontWeight: "700" }}>
            {props.ask.title}
          </Text>
          <View
            class="h-12 justify-center rounded-2xl px-4"
            style={{ backgroundColor: look().card, borderCurve: "continuous" }}
          >
            <Input
              testID="prompt-text"
              value={text()}
              placeholder={props.ask.placeholder}
              autoFocus
              autoCorrect={false}
              returnKeyType="done"
              onChange={({ value }) => {
                text.set(value);
                error.set("");
              }}
              onSubmit={() => void submit()}
              style={{ color: look().ink, fontSize: 17, placeholderColor: look().inkFaint }}
            />
          </View>
          <If when={error()}>
            <Text style={{ color: look().stamp, fontSize: 13 }}>{error()}</Text>
          </If>
          <View class="flex-row gap-3">
            <View class="flex-1">
              <GlassButton label="Cancel" onPress={() => close(false)} />
            </View>
            <View class="flex-1" style={{ opacity: text().trim() && !busy() ? 1 : 0.5 }}>
              <GlassButton
                label={busy() ? "Saving…" : props.ask.confirm}
                prominent
                testID="prompt-confirm"
                onPress={() => void submit()}
              />
            </View>
          </View>
        </View>
      </View>
    </View>
  );
}
