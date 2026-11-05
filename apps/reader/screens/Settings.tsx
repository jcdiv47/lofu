import { signal, Text, View } from "nsh";
import { Input } from "nsh/base";
import { loadSettings, saveSettings } from "../lib/api";
import { look } from "../lib/look";

export function Settings(props: { onDone: () => void }) {
  const server = signal("");
  const token = signal("");
  void loadSettings().then((s) => {
    server.set(s.server);
    token.set(s.token);
  });
  const field = (
    label: string,
    id: string,
    value: () => string,
    set: (v: string) => void,
    placeholder: string,
  ) => (
    <View class="gap-1">
      <Text style={{ color: look().inkFaint, fontSize: 11, fontFamily: "monospace" }}>{label}</Text>
      <Input
        testID={id}
        value={value()}
        placeholder={placeholder}
        autoCapitalize="none"
        autoCorrect={false}
        onChange={({ value: v }) => set(v)}
        class="py-2 text-[16px]"
        style={{ color: look().ink, borderBottomWidth: 1, borderColor: look().rule }}
      />
    </View>
  );
  return (
    <View class="flex-1 gap-6 px-6 pt-6" style={{ backgroundColor: look().paper }}>
      <Text style={{ color: look().ink, fontSize: 26, fontFamily: "serif" }}>Your server</Text>
      {field(
        "SERVER ADDRESS",
        "server",
        server,
        (v) => server.set(v),
        "https://homebox.tail1234.ts.net",
      )}
      {field("API TOKEN", "token", token, (v) => token.set(v), "lofu_…")}
      <View
        onPress={async () => {
          await saveSettings({ server: server(), token: token() });
          props.onDone();
        }}
        role="button"
        class="self-start rounded-md px-5 py-3 active:opacity-70"
        style={{ backgroundColor: look().ink }}
      >
        <Text style={{ color: look().paper, fontSize: 15, fontWeight: "600" }}>Save</Text>
      </View>
    </View>
  );
}
