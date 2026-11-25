import { TextPrompt } from "lofu/native";
import { batch, keyboardFrame, safeArea, signal, Text, View } from "nsh";
import { Input } from "nsh/base";
import { onAndroidBack } from "../lib/android";
import { glass, look } from "../lib/look";
import { ErrorText, GlassButton, GlassTint } from "./ui";

/**
 * Asks for a line of text (a new name). On iOS, the system's alert with a
 * text field (`src/prompt.rs`, Liquid Glass on iOS 26); elsewhere a small
 * card of glass over the app, above the keyboard, since `nsh-core` 0.6.1's
 * native `AlertDialog` doesn't implement `input` yet. `run` does the work
 * and may throw: its message shows on the card, which stays open (the alert
 * opens again with it); resolves with whether it was done.
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
/** Whether a prompt is open. */
export const prompting = () => !!asking();

/** The system's alert asks, rather than the app's card. */
export const systemPrompt = TextPrompt.available();

export function promptText(opts: Omit<Ask, "done">): Promise<boolean> {
  if (systemPrompt) return askSystem(opts);
  asking()?.done(false);
  return new Promise((done) => asking.set({ ...opts, done }));
}

/** The system's alert, asked again with the error until `run` succeeds or it's cancelled. */
async function askSystem(opts: Omit<Ask, "done">): Promise<boolean> {
  let message = "";
  let value = opts.value;
  for (;;) {
    const answer = JSON.parse(
      await TextPrompt.ask(
        opts.title,
        message,
        value,
        opts.placeholder,
        opts.confirm,
        look().stamp,
      ),
    ) as { text: string } | null;
    const text = answer?.text.trim();
    if (!answer || !text) return false;
    try {
      await opts.run(text);
      return true;
    } catch (e) {
      message = (e as Error).message;
      value = answer.text;
    }
  }
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
  onAndroidBack(() => close(false));
  const submit = async () => {
    if (!text().trim() || busy()) return;
    batch(() => {
      busy.set(true);
      error.set("");
    });
    try {
      await props.ask.run(text().trim());
      close(true);
    } catch (e) {
      batch(() => {
        error.set((e as Error).message);
        busy.set(false);
      });
    }
  };
  /** Over the keyboard on phones; a third of the way down elsewhere. */
  const top = () =>
    keyboardFrame().height > 0
      ? Math.max(safeArea().top + 16, 80)
      : Math.max(safeArea().top + 80, 140);
  return (
    <View class="absolute inset-0" style={{ zIndex: 100 }}>
      <View class="absolute inset-0 bg-black/25" onPress={() => close(false)} />
      <View class="absolute right-0 left-0 items-center px-5" style={{ top: top() }}>
        <View
          testID="prompt-card"
          class="w-full gap-4 overflow-hidden rounded-[26px] p-5"
          style={{ ...glass(), borderCurve: "continuous", maxWidth: 420 }}
        >
          <GlassTint radius={26} />
          <Text class="text-center text-ink" style={{ fontSize: 17, fontWeight: "700" }}>
            {props.ask.title}
          </Text>
          <View
            class="h-12 justify-center rounded-2xl bg-card px-4"
            style={{ borderCurve: "continuous" }}
          >
            <Input
              testID="prompt-text"
              value={text()}
              placeholder={props.ask.placeholder}
              autoFocus
              autoCorrect={false}
              returnKeyType="done"
              onChange={({ value }) => {
                batch(() => {
                  text.set(value);
                  error.set("");
                });
              }}
              onSubmit={() => void submit()}
              class="text-ink placeholder:text-ink-faint"
              style={{ fontSize: 17 }}
            />
          </View>
          <If when={error()}>
            <ErrorText text={error()} />
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
