// Extension-only artwork: transparent background and a slightly larger monkey.
// Keep the shared app/logo artwork unchanged.
const source = await Bun.file(new URL("../assets/icon.png", import.meta.url)).bytes();
const out = new URL("../public/icon/", import.meta.url);

for (const size of [16, 32, 48, 96, 128]) {
  const bytes = await new Bun.Image(source).resize(size).png().bytes();
  await Bun.write(new URL(`${size}.png`, out), bytes);
}
console.log("icons written to public/icon/");
