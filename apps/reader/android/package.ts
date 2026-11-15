import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

// nsh owns the native runtime and bundle. Add only the host activity and manifest;
// never patch an installed nsh or depend on its source checkout.
const root = resolve(import.meta.dir, "../../..");
const sdk = process.env.ANDROID_HOME;
if (!sdk) throw new Error("Set ANDROID_HOME to your Android SDK (see android/README.md).");
const tools = join(sdk, "build-tools/35.0.0");
const jar = join(sdk, "platforms/android-35/android.jar");
const out = join(root, ".nsh/out");
const testing = process.argv.includes("--test");
const metadata = (await Bun.file(join(root, "apps/reader/nsh.json")).json()) as {
  build: number;
  version: string;
};
const work = await mkdtemp(join(tmpdir(), "lofu-apk-"));
function run(args: string[], cwd = work) {
  const result = Bun.spawnSync(args, { cwd, stdout: "inherit", stderr: "inherit" });
  if (result.exitCode) throw new Error(`Command failed: ${args[0]}`);
}
try {
  run(["nsh", "package", "apps/reader", "--target", "android", "--abi", "arm64-v8a"], root);
  run(["unzip", "-q", join(out, "lofu.apk"), "-d", "base"]);
  await mkdir(join(work, "stub/com/longbridge/nsh"), { recursive: true });
  // Compile-time API declarations only. The APK uses nsh's real implementation.
  await Bun.write(
    join(work, "stub/com/longbridge/nsh/NshView.java"),
    `package com.longbridge.nsh;
public class NshView extends android.view.View {
 public NshView(android.content.Context c) { super(c); }
 public interface HostHandler { void handle(Object data, NshHostReply reply); }
 public void handle(String n, HostHandler h) {} public boolean send(String n, Object d) { return true; }
 public void useStandaloneLimits() {} public boolean loadAssetBundle(String s, boolean p) { return true; }
 public boolean handleBack() { return false; } public void destroy() {}
}`,
  );
  await Bun.write(
    join(work, "stub/com/longbridge/nsh/NshHostReply.java"),
    `package com.longbridge.nsh;
public class NshHostReply { public void resolve(Object o) {} public void reject(String s) {} }`,
  );
  await mkdir(join(work, "classes"));
  run([
    "javac",
    "-source",
    "8",
    "-target",
    "8",
    "-classpath",
    jar,
    "-d",
    "classes",
    "stub/com/longbridge/nsh/NshView.java",
    "stub/com/longbridge/nsh/NshHostReply.java",
    join(import.meta.dir, "LofuActivity.java"),
  ]);
  await mkdir(join(work, "dex"));
  run([
    join(tools, "d8"),
    "--min-api",
    "26",
    "--lib",
    jar,
    "--output",
    "dex",
    "classes/com/longbridge/nsh/LofuActivity.class",
    "base/classes.dex",
  ]);
  await mkdir(join(work, "res/mipmap-xxxhdpi"), { recursive: true });
  await Bun.write(
    join(work, "res/mipmap-xxxhdpi/ic_launcher.png"),
    Bun.file(join(root, "design/logo/logo.png")),
  );
  await mkdir(join(work, "compiled"));
  run([join(tools, "aapt2"), "compile", "--dir", "res", "-o", "compiled"]);
  const manifest = await Bun.file(join(import.meta.dir, "AndroidManifest.xml")).text();
  await Bun.write(
    join(work, "AndroidManifest.xml"),
    testing
      ? manifest
          .replace('package="app.lofu.reader"', 'package="app.lofu.reader.e2e"')
          .replace('android:label="lofu"', 'android:label="lofu Test"')
          .replace("app.lofu.reader.files", "app.lofu.reader.e2e.files")
      : manifest,
  );
  run([
    join(tools, "aapt2"),
    "link",
    "-o",
    "app.apk",
    "-I",
    jar,
    "--manifest",
    "AndroidManifest.xml",
    "--min-sdk-version",
    "26",
    "--target-sdk-version",
    "35",
    "--version-code",
    String(metadata.build),
    "--version-name",
    metadata.version,
    "compiled/mipmap-xxxhdpi_ic_launcher.png.flat",
  ]);
  run(["cp", "dex/classes.dex", "base/classes.dex"]);
  run(
    ["zip", "-q", "-r", "-0", join(work, "app.apk"), "classes.dex", "assets", "lib"],
    join(work, "base"),
  );
  run([join(tools, "zipalign"), "-P", "16", "-f", "4", "app.apk", "aligned.apk"]);
  const keystore = process.env.LOFU_ANDROID_KEYSTORE || join(homedir(), ".android/debug.keystore");
  const alias = process.env.LOFU_ANDROID_KEY_ALIAS || "androiddebugkey";
  const password = process.env.LOFU_ANDROID_KEYSTORE_PASSWORD || "android";
  if (!(await Bun.file(keystore).exists())) {
    if (process.env.LOFU_ANDROID_KEYSTORE) throw new Error("Release keystore does not exist");
    await mkdir(dirname(keystore), { recursive: true });
    run([
      "keytool",
      "-genkeypair",
      "-keystore",
      keystore,
      "-storepass",
      password,
      "-keypass",
      password,
      "-alias",
      alias,
      "-keyalg",
      "RSA",
      "-validity",
      "10000",
      "-dname",
      "CN=lofu Android development",
    ]);
  }
  await Bun.write(join(work, "password"), `${password}\n${password}\n`);
  await chmod(join(work, "password"), 0o600);
  run([
    join(tools, "apksigner"),
    "sign",
    "--ks",
    keystore,
    "--ks-key-alias",
    alias,
    "--ks-pass",
    `file:${join(work, "password")}`,
    "--key-pass",
    `file:${join(work, "password")}`,
    "aligned.apk",
  ]);
  run([join(tools, "apksigner"), "verify", "aligned.apk"]);
  const apk = join(out, testing ? "lofu-android-test.apk" : "lofu-android.apk");
  await Bun.write(apk, Bun.file(join(work, "aligned.apk")));
  console.log(`APK: ${apk}`);
} finally {
  await rm(work, { recursive: true, force: true });
}
