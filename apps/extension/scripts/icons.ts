// Renders public/icon.svg to the PNG sizes browsers require (needs rsvg-convert).
for (const size of [16, 32, 48, 96, 128]) {
  const proc = Bun.spawnSync([
    "rsvg-convert",
    "-w",
    String(size),
    "-h",
    String(size),
    "public/icon.svg",
    "-o",
    `public/icon/${size}.png`,
  ]);
  if (proc.exitCode !== 0) throw new Error(proc.stderr.toString());
}
console.log("icons written to public/icon/");
