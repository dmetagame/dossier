import sharp from "sharp";
// Dossier mark: a document/report page with a folded corner and content lines,
// indigo accent to distinguish from Verdict's green shield.
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0B1220"/><stop offset="1" stop-color="#161B34"/>
    </linearGradient>
    <linearGradient id="acc" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#7C8CF8"/><stop offset="1" stop-color="#5563E6"/>
    </linearGradient>
  </defs>
  <!-- Square corners: OKX review asked for no rounded corners, and the
       marketplace applies its own masking. rx here would leave transparent
       corners baked into the PNG. -->
  <rect width="512" height="512" fill="url(#bg)"/>
  <!-- page with folded corner -->
  <path d="M168 132 H300 L356 188 V380 H168 Z" fill="#fff" opacity="0.06"
        stroke="url(#acc)" stroke-width="14" stroke-linejoin="round"/>
  <path d="M300 132 V188 H356" fill="none" stroke="url(#acc)" stroke-width="14" stroke-linejoin="round"/>
  <!-- content lines -->
  <g stroke="url(#acc)" stroke-width="16" stroke-linecap="round">
    <line x1="204" y1="238" x2="320" y2="238"/>
    <line x1="204" y1="286" x2="320" y2="286"/>
    <line x1="204" y1="334" x2="284" y2="334"/>
  </g>
</svg>`;
await sharp(Buffer.from(svg)).png().toFile("submission/avatar-dossier.png");
const m = await sharp("submission/avatar-dossier.png").metadata();
console.log("wrote submission/avatar-dossier.png", m.width+"x"+m.height, m.format);
