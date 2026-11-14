package com.longbridge.nsh;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import com.longbridge.nsh.NshView;
import java.security.KeyStore;
import java.util.concurrent.Executors;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** Only the Android integration; all application UI and sync live in App.tsx. */
public final class LofuActivity extends Activity {
    private NshView view;
    private final java.util.concurrent.ExecutorService io = Executors.newSingleThreadExecutor();
    private static final String KEY = "lofu.connection.v1";

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        // Rust's Files module must use this app's private container, not an absent HOME.
        try { android.system.Os.setenv("HOME", getFilesDir().getAbsolutePath(), true); }
        catch (Exception e) { throw new IllegalStateException("Private storage unavailable", e); }
        getWindow().setStatusBarColor(android.graphics.Color.rgb(250, 248, 244));
        getWindow().getDecorView().setSystemUiVisibility(android.view.View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR);
        view = new NshView(this);
        view.useStandaloneLimits();
        // Crypto/file I/O is never done on the UI thread. No token crosses an intent.
        view.handle("lofu.secret.read", (data, reply) -> io.execute(() -> {
            try { reply.resolve(readSecret()); }
            catch (Exception e) { reply.reject("Cannot unlock the saved token. Reconnect in Settings."); }
        }));
        view.handle("lofu.secret.write", (data, reply) -> io.execute(() -> {
            try { writeSecret((String)data); reply.resolve(true); }
            catch (Exception e) { reply.reject("Cannot securely store the token."); }
        }));
        view.handle("lofu.share", (data, reply) -> {
            Intent send = new Intent(Intent.ACTION_SEND).setType("text/plain")
                .putExtra(Intent.EXTRA_TEXT, (String)data);
            startActivity(Intent.createChooser(send, "Share link"));
            reply.resolve(true);
        });
        setContentView(view);
        view.loadAssetBundle("nsh", true);
        receive(getIntent());
    }

    private SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (!store.containsAlias(KEY)) {
            KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            generator.init(new KeyGenParameterSpec.Builder(KEY,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
            generator.generateKey();
        }
        return (SecretKey)store.getKey(KEY, null);
    }

    private String readSecret() throws Exception {
        String stored = getSharedPreferences("connection", MODE_PRIVATE).getString("token", "");
        if (stored.isEmpty()) return "";
        String[] parts = stored.split(":", 2);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP)));
        return new String(cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP)), java.nio.charset.StandardCharsets.UTF_8);
    }

    private void writeSecret(String token) throws Exception {
        String encrypted = "";
        if (!token.isEmpty()) {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key());
            encrypted = Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP) + ":" +
                Base64.encodeToString(cipher.doFinal(token.getBytes(java.nio.charset.StandardCharsets.UTF_8)), Base64.NO_WRAP);
        }
        if (!getSharedPreferences("connection", MODE_PRIVATE).edit().putString("token", encrypted).commit())
            throw new java.io.IOException("Storage full");
    }

    private void receive(Intent intent) {
        if (intent != null && Intent.ACTION_SEND.equals(intent.getAction()) && "text/plain".equals(intent.getType())) {
            CharSequence text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
            if (text != null && text.length() <= 65536) view.send("lofu.incomingShare", text.toString());
            // Do not replay a consumed share after recreation.
            intent.removeExtra(Intent.EXTRA_TEXT);
        }
    }
    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        receive(intent);
    }
    @Override public void onConfigurationChanged(android.content.res.Configuration config) {
        super.onConfigurationChanged(config);
    }
    @Override @SuppressWarnings("deprecation") public void onBackPressed() {
        if (view == null || !view.handleBack()) super.onBackPressed();
    }
    @Override protected void onDestroy() {
        view.destroy();
        io.shutdown();
        super.onDestroy();
    }
}
