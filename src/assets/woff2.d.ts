declare module "*.woff2" {
  /** Base64 of the font file, embedded at build time by esbuild. */
  const data: string;
  export default data;
}
