import sharp from "sharp";
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0B1220"/><stop offset="1" stop-color="#15233B"/>
    </linearGradient>
    <linearGradient id="acc" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#3DE1B0"/><stop offset="1" stop-color="#24B98A"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="112" fill="url(#bg)"/>
  <path d="M256 84 L392 132 V262 C392 350 330 404 256 436 C182 404 120 350 120 262 V132 Z"
        fill="none" stroke="url(#acc)" stroke-width="20" stroke-linejoin="round" opacity="0.55"/>
  <path d="M186 258 L238 312 L340 196" fill="none" stroke="url(#acc)"
        stroke-width="40" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;
await sharp(Buffer.from(svg)).png().toFile("submission/avatar.png");
const m = await sharp("submission/avatar.png").metadata();
console.log("wrote submission/avatar.png", m.width+"x"+m.height, m.format, (await import("node:fs")).statSync("submission/avatar.png").size+"b");
