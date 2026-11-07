#!/usr/bin/env bun
/**
 * Packages the iOS app with its share extension: nsh can't build app
 * extensions, so this packages the app with `nsh package`, builds the
 * extension (`project.yml`: xcodegen, then xcodebuild, which signs it with
 * your team and makes its provisioning profile), puts it in the app's
 * `PlugIns/` and signs the app again.
 *
 *   bun share/package.ts ios-simulator [--install]
 *   bun share/package.ts ios --sign "Apple Development: …" --profile <app.lofu.reader's .mobileprovision> [--install --device <udid>]
 *
 * The app and the extension share a Keychain group (`<team>.app.lofu.shared`),
 * which the app's Info.plist names (`LofuKeychainGroup`): the app puts the
 * server address and token there, and the extension saves with them.
 * Writes `.nsh/out/lofu.app` (simulator) or `.nsh/out/lofu.ipa` (devices).
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { $ } from "bun";

const { values: opts, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: {
    sign: { type: "string" },
    profile: { type: "string" },
    team: { type: "string" },
    install: { type: "boolean" },
    device: { type: "string" },
  },
});

const target = positionals[0];
if (target !== "ios" && target !== "ios-simulator") {
  console.error("usage: bun share/package.ts ios-simulator|ios [--sign … --profile …] [--install]");
  process.exit(2);
}
const device = target === "ios";
if (device && (!opts.sign || !opts.profile)) {
  console.error("ios needs --sign <identity> and --profile <app.lofu.reader's .mobileprovision>");
  process.exit(2);
}

const app = resolve(import.meta.dir, "..");
const share = import.meta.dir;
const work = join(app, ".nsh/share");
const out = join(app, ".nsh/out");
const nsh = JSON.parse(readFileSync(join(app, "nsh.json"), "utf8")) as {
  id: string;
  version: string;
  build: number;
};

/** What a provisioning profile (a signed plist) says about the team and entitlements. */
async function readProfile(path: string) {
  const plist = join(work, "profile.plist");
  await $`security cms -D -i ${path} -o ${plist}`.quiet();
  const team = (await $`plutil -extract TeamIdentifier.0 raw -o - ${plist}`.quiet().text()).trim();
  const entitlements = JSON.parse(
    await $`plutil -extract Entitlements json -o - ${plist}`.quiet().text(),
  ) as Record<string, unknown>;
  return { team, entitlements };
}

rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });

const profile = device ? await readProfile(resolve(opts.profile!)) : null;
const team = opts.team ?? profile?.team;
const group = team ? `${team}.app.lofu.shared` : "app.lofu.shared";

// The app's own entitlements, with the shared group added. nsh signs with
// the profile's, whose Keychain group is `<team>.*`; a signature names its
// groups. The simulator takes no entitlements in an ad hoc signature (the
// app wouldn't launch): they go into the binary instead, as Xcode does
// (`__TEXT,__entitlements`), when nsh links the runner. They're kept out of
// `work`, by their contents, so cargo relinks when they change.
const entitlements: Record<string, unknown> = profile
  ? { ...profile.entitlements }
  : { "application-identifier": team ? `${team}.${nsh.id}` : nsh.id };
entitlements["keychain-access-groups"] = [team ? `${team}.${nsh.id}` : nsh.id, group];
const entitlementsJson = JSON.stringify(entitlements);
const entitlementsDir = join(
  app,
  ".nsh/share-entitlements",
  new Bun.CryptoHasher("sha256").update(entitlementsJson).digest("hex").slice(0, 16),
);
const entitlementsXml = join(entitlementsDir, "lofu.xcent");
const entitlementsDer = join(entitlementsDir, "lofu.xcent.der");
mkdirSync(entitlementsDir, { recursive: true });
writeFileSync(entitlementsXml, entitlementsJson);
await $`plutil -convert xml1 ${entitlementsXml}`;
await $`derq query -f xml -i ${entitlementsXml} -o ${entitlementsDer} --raw`;

console.log(`▸ nsh package --target ${target}`);
const packageArgs = device ? ["--sign", opts.sign!, "--profile", resolve(opts.profile!)] : [];
const env: Record<string, string | undefined> = {
  ...process.env,
  // Without it the runner links for iOS 10, which lacks `___chkstk_darwin` (README).
  IPHONEOS_DEPLOYMENT_TARGET: "17.0",
};
if (!device) {
  const sections = [
    `-C link-arg=-Wl,-sectcreate,__TEXT,__entitlements,${entitlementsXml}`,
    `-C link-arg=-Wl,-sectcreate,__TEXT,__ents_der,${entitlementsDer}`,
  ];
  env.RUSTFLAGS = [process.env.RUSTFLAGS, ...sections].filter(Boolean).join(" ");
}
await $`nsh package App.tsx --target ${target} ${packageArgs}`.cwd(app).env(env);

let bundle = join(out, "lofu.app");
if (device) {
  await $`unzip -q ${join(out, "lofu.ipa")} -d ${join(work, "ipa")}`;
  bundle = join(work, "ipa/Payload/lofu.app");
}
if (!existsSync(join(bundle, "Info.plist"))) throw new Error(`no app at ${bundle}`);

console.log("▸ building the share extension");
await $`xcodegen generate --quiet --spec ${join(share, "project.yml")} --project ${work}`;
const sdk = device ? "iphoneos" : "iphonesimulator";
const settings = [
  `LOFU_SHARE=${share}`,
  `SYMROOT=${join(work, "build")}`,
  `OBJROOT=${join(work, "obj")}`,
  `MARKETING_VERSION=${nsh.version}`,
  `CURRENT_PROJECT_VERSION=${nsh.build}`,
  `LOFU_KEYCHAIN_GROUP=${group}`,
  ...(team ? [`DEVELOPMENT_TEAM=${team}`] : []),
  ...(device ? [] : ["ARCHS=arm64", "CODE_SIGN_IDENTITY=-"]),
];
const provisioning = device ? ["-allowProvisioningUpdates"] : [];
const xcodebuild =
  await $`xcodebuild -quiet -project ${join(work, "LofuShare.xcodeproj")} -target LofuShare -configuration Release -sdk ${sdk} ${provisioning} build ${settings}`
    .nothrow()
    .quiet();
if (xcodebuild.exitCode !== 0) {
  // Its errors, without the compiler's command lines.
  const log = `${xcodebuild.stdout}${xcodebuild.stderr}`.split("\n");
  console.error(log.filter((l) => /error:|^\s*\d* \||^\s+[|`]-/.test(l)).join("\n"));
  process.exit(1);
}
const appex = join(work, `build/Release-${sdk}/LofuShare.appex`);

console.log("▸ adding it to lofu.app");
mkdirSync(join(bundle, "PlugIns"), { recursive: true });
rmSync(join(bundle, "PlugIns/LofuShare.appex"), { recursive: true, force: true });
await $`cp -R ${appex} ${join(bundle, "PlugIns/")}`;
await $`plutil -replace LofuKeychainGroup -string ${group} ${join(bundle, "Info.plist")}`;

if (device) {
  await $`codesign --force --sign ${opts.sign!} --entitlements ${entitlementsXml} --generate-entitlement-der ${bundle}`;
} else {
  // Its entitlements are in the binary (above); the signature stays ad hoc.
  await $`codesign --force --sign - ${bundle}`;
}
await $`codesign --verify --deep --strict ${bundle}`;

if (device) {
  rmSync(join(out, "lofu.ipa"), { force: true });
  await $`zip -qry ${join(out, "lofu.ipa")} Payload`.cwd(join(work, "ipa"));
  console.log(`✓ ${join(out, "lofu.ipa")}`);
} else {
  console.log(`✓ ${bundle}`);
}

if (opts.install) {
  const on = opts.device ?? (device ? null : "booted");
  if (!on) throw new Error("--install on a phone needs --device <udid>");
  if (device) await $`xcrun devicectl device install app --device ${on} ${bundle}`;
  else await $`xcrun simctl install ${on} ${bundle}`;
  console.log(`✓ installed on ${on}`);
}
