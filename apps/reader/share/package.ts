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
 * For TestFlight, sign with Apple Distribution and App Store profiles for
 * both: `--sign "Apple Distribution: …" --profile <app's> --share-profile
 * <extension's>`. `--id` packages it under another bundle id (the
 * extension's is `<id>.share`), for a team that doesn't own `nsh.json`'s.
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
    id: { type: "string" },
    "share-profile": { type: "string" },
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

const id = opts.id ?? nsh.id;

/** What a provisioning profile (a signed plist) says about the team and entitlements. */
async function readProfile(path: string) {
  const plist = join(work, "profile.plist");
  await $`security cms -D -i ${path} -o ${plist}`.quiet();
  const read = async (key: string) =>
    (await $`plutil -extract ${key} raw -o - ${plist}`.quiet().text()).trim();
  const team = await read("TeamIdentifier.0");
  const uuid = await read("UUID");
  const entitlements = JSON.parse(
    await $`plutil -extract Entitlements json -o - ${plist}`.quiet().text(),
  ) as Record<string, unknown>;
  return { team, uuid, entitlements };
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
const entitlements: Record<string, unknown> = { ...profile?.entitlements };
// A wildcard profile (`<team>.*`) signs any bundle id; the signature has to name this one.
entitlements["application-identifier"] = team ? `${team}.${id}` : id;
entitlements["keychain-access-groups"] = [team ? `${team}.${id}` : id, group];
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

// The runner and the extension are built for it, and nsh.json's
// `ios.infoPlist` says so (nsh's default is 15.0, which App Store Connect
// rejects: ITMS-90208).
const minimumOS = "17.0";

console.log(`▸ nsh package --target ${target}`);
const packageArgs = [
  "--id",
  id,
  ...(device ? ["--sign", opts.sign!, "--profile", resolve(opts.profile!)] : []),
];
const env: Record<string, string | undefined> = {
  ...process.env,
  // Without it the runner links for iOS 10, which lacks `___chkstk_darwin` (README).
  IPHONEOS_DEPLOYMENT_TARGET: minimumOS,
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
  `PRODUCT_BUNDLE_IDENTIFIER=${id}.share`,
  ...(device ? [] : ["ARCHS=arm64", "CODE_SIGN_IDENTITY=-"]),
];
// An App Store build signs the extension with the given profile; otherwise
// xcodebuild signs it for development and makes its profile.
const shareProfile = device && opts["share-profile"] ? resolve(opts["share-profile"]) : null;
if (shareProfile) {
  const { uuid } = await readProfile(shareProfile);
  const installed = join(
    process.env.HOME!,
    "Library/Developer/Xcode/UserData/Provisioning Profiles",
  );
  mkdirSync(installed, { recursive: true });
  const copy = join(installed, `${uuid}.mobileprovision`);
  // Xcode's own downloads are already there; cp refuses to copy a file onto itself.
  if (resolve(copy) !== shareProfile) await $`cp ${shareProfile} ${copy}`;
  settings.push(
    "CODE_SIGN_STYLE=Manual",
    `CODE_SIGN_IDENTITY=${opts.sign!}`,
    `PROVISIONING_PROFILE_SPECIFIER=${uuid}`,
  );
}
const provisioning = device && !shareProfile ? ["-allowProvisioningUpdates"] : [];
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
