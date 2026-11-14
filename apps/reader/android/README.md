# Android

The existing Native Shell reader, not a WebView wrapper or a second client. Library, collections, tags, favorites, search, editing, reading, highlights, cached articles and the offline outbox use the same TSX/Rust code as the other readers. Android adds a small Java host for the Keystore and incoming/outgoing shares. Requires Android 8/API 26 or newer; the packaging script currently builds **arm64-v8a** (including Nothing Phone (2)).

## Build and install

Install Bun, Rust, Native Shell **0.5.0**, JDK 17, and the Android command-line tools. Accept the SDK licenses, then:

```sh
export ANDROID_HOME=/path/to/android-sdk
export JAVA_HOME=/path/to/jdk-17
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$PATH"
sdkmanager 'platform-tools' 'platforms;android-35' 'build-tools;35.0.0' 'ndk;27.2.12479018'
rustup target add aarch64-linux-android
bun install --frozen-lockfile
bun run reader:android
adb devices -l
adb -s <serial> install -r .nsh/out/lofu-android.apk
adb -s <serial> shell am start -n app.lofu.reader/com.longbridge.nsh.LofuActivity
```

On this Mac the SDK is `/opt/homebrew/share/android-commandlinetools` and JDK 17 is `/opt/homebrew/opt/openjdk@17`. `nsh` downloads its Android runtime component if missing. Its Rust build discovers the installed NDK; if several are installed, set `ANDROID_NDK_HOME` to the one to use.

The result is a debug-key-signed APK, suitable for sideloading, not a Play Store release. To sign with your own key, set `LOFU_ANDROID_KEYSTORE`, `LOFU_ANDROID_KEY_ALIAS`, and `LOFU_ANDROID_KEYSTORE_PASSWORD`. Preserve that key for updates. `adb install -r` preserves the app's data; if Android reports a signature mismatch, **do not uninstall** a user's existing app to work around it.

`package.ts` first asks `nsh package` to build the ordinary reader and its Rust modules. It merges only `LofuActivity` into the runtime's DEX, adds the app manifest/icon, aligns the native libraries to 16 KB, signs, and verifies the APK. The Java API declarations are compile-only stubs, never packaged. The activity lives in `com.longbridge.nsh` because the standalone limits and packaged-bundle loader are package-private in nsh 0.5.0. Recheck this integration and the device test when upgrading nsh. The app loads its **TSX bundle with Rust modules**, not a Rust-root app (`Native.runRust` is not exported by this build).

## Connect

Enter your server URL and a bearer token made **on that server**:

```sh
bun apps/server/src/admin.ts token create nothing-phone
```

Use HTTPS over your LAN/Tailscale for normal use. For a server listening on this Mac's loopback and a USB-connected phone:

```sh
adb -s <serial> reverse tcp:8787 tcp:8787
```

Then use `http://127.0.0.1:8787` in the phone app. This address works only while the USB tunnel and Mac server are available. Cleartext HTTP is allowed for self-hosted LAN/development servers; it does not encrypt the token on the network.

The token is AES-GCM encrypted with a non-exportable Android Keystore key. The ciphertext is in app-private preferences; backups are disabled. Legacy plaintext tokens in nsh Storage are migrated and removed. A Keystore/bridge failure is shown instead of falling back to plaintext. Local article/snapshot files stay inside this Android app's private container; they are not separately encrypted.

## Sharing

Choose **lofu** from another app's Android share sheet (`ACTION_SEND`, `text/plain`). The incoming text opens a **Save shared link** confirmation; the normal URL extractor handles a link embedded in share text. Nothing is saved until Save is pressed. A share received before first-launch connection waits until setup is complete; Cancel discards it. The reader's **More → Share…** opens Android's chooser. Neither intent carries credentials.

## Physical-device smoke test

Unlock the phone and authorize USB debugging. The test builds and installs a separate **lofu Test** app (`app.lofu.reader.e2e`), resets **only that test package**, starts a temporary authenticated API/database, and uses an ephemeral `adb reverse` tunnel. It never reads or writes the real library and never clears `app.lofu.reader`.

```sh
ANDROID_SERIAL=<serial> bun run reader:android:test
```

It checks cold-launch sharing through setup and cancellation, authenticated connection, article rendering, a server-side favorite change, Android's outgoing chooser, Keystore persistence across a killed process, local search fallback, incoming share/save, and cached library/article reading after removing the network tunnel. The database/server and tunnel are cleaned up afterward. Screenshots are written to `apps/reader/android/screens/` (ignored by git); inspect them, because layout regressions do not necessarily fail assertions.

Validated on a USB-connected Nothing A065/Pong (Phone (2)), Android 16. Full-text online search needs Meilisearch; this isolated test exercises the local fallback. This is a sideloadable development build, not a store release. Long-press highlighting, offline image rendering, background sync, and Android devices/versions other than this phone still need broader manual coverage.

The shared-reader checks are `bun run reader:test` and `apps/reader/e2e/web.ts`. The latter accepts `READER_PROFILE` to use a fresh Chrome test profile rather than stale credentials from an earlier run. In this change's isolated web run, existing highlight rendering passed but mouse-drag creation of a new highlight did not show its bubble (the follow-on highlight assertions consequently failed); this is not covered by the Android smoke test.
