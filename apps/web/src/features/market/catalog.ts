/**
 * The companies behind the tokens, for presentation only.
 *
 * `logo` points at a self-hosted file rather than the DexScreener CDN the images came from.
 * Hotlinking would make every asset row depend on a third party staying up and keeping a URL
 * stable, and a broken logo during a demo is a broken product to whoever is watching. All seven
 * together are 32 kB.
 *
 * `letter` and `color` remain the fallback: a symbol with no entry here, or an image that fails
 * to load, still renders something with the right shape instead of a gap in the row.
 */
export const companies: Record<
  string,
  { name: string; letter: string; color: string; logo: string }
> = {
  AAPLc: { name: "Apple", letter: "A", color: "apple", logo: "/tokens/AAPLc.jpg" },
  NVDAc: { name: "NVIDIA", letter: "N", color: "nvidia", logo: "/tokens/NVDAc.jpg" },
  GOOGLc: { name: "Alphabet", letter: "G", color: "google", logo: "/tokens/GOOGLc.jpg" },
  METAc: { name: "Meta", letter: "∞", color: "meta", logo: "/tokens/METAc.jpg" },
  MSFTc: { name: "Microsoft", letter: "M", color: "microsoft", logo: "/tokens/MSFTc.jpg" },
  AMZNc: { name: "Amazon", letter: "A", color: "amazon", logo: "/tokens/AMZNc.jpg" },
  TSLAc: { name: "Tesla", letter: "T", color: "tesla", logo: "/tokens/TSLAc.jpg" },
};

export const stocks = Object.keys(companies);
