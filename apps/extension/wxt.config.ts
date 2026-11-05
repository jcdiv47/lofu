import { defineConfig } from "wxt";

export default defineConfig({
  manifestVersion: 3,
  manifest: ({ browser }) => ({
    name: "lofu",
    description: "Save pages, exactly as you see them, to your own lofu server.",
    permissions: ["activeTab", "scripting", "storage", "contextMenus", "alarms"],
    // Least privilege: saving uses activeTab (granted by the click/shortcut/
    // menu); the server allows extension origins via CORS; all-sites access
    // is requested only if the user turns on auto-repair. E2E builds get it
    // up front because automation can't click permission prompts.
    ...(process.env.LOFU_E2E
      ? { host_permissions: ["<all_urls>"] }
      : { optional_host_permissions: ["<all_urls>"] }),
    // Opening the popup saves the page, so the shortcut just opens it.
    commands: {
      _execute_action: {
        suggested_key: { default: "Alt+Shift+S" },
        description: "Save the current page to lofu",
      },
    },
    ...(browser === "firefox"
      ? {
          browser_specific_settings: {
            gecko: { id: "lofu@lofu.local", strict_min_version: "128.0" },
          },
        }
      : {}),
  }),
});
