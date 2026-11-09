// Writes the PNG sizes browsers require from the logo in design/logo/: its
// hand-drawn small sizes as they are, the others resized from logo.png.
const logo = new URL("../../../design/logo/", import.meta.url);
const out = new URL("../public/icon/", import.meta.url);

for (const size of [16, 32, 48, 96, 128]) {
  const drawn = Bun.file(new URL(`icon-${size}.png`, logo));
  const bytes = (await drawn.exists())
    ? await drawn.bytes()
    : await new Bun.Image(await Bun.file(new URL("logo.png", logo)).bytes())
        .resize(size)
        .png()
        .bytes();
  await Bun.write(new URL(`${size}.png`, out), bytes);
}
console.log("icons written to public/icon/");
