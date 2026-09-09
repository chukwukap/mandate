import type { NextConfig } from "next";

const config: NextConfig = {
  poweredByHeader: false,
  devIndicators: false,
  // The dev server blocks hydration payloads and HMR for any host it does not consider its own
  // origin, silently: the page renders server-side and React never attaches. Browsers on
  // `localhost` were fine; every headless probe used `127.0.0.1` and hydrated nothing, which was
  // misread for a long time as Privy stalling. Both hosts are allowed so a test and a person
  // can reach the same running app.
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  transpilePackages: ["@mandate/contracts"],
  async rewrites() {
    const origin = process.env.MANDATE_API_URL ?? "http://127.0.0.1:8080";
    return [{ source: "/api/mandate/:path*", destination: `${origin}/:path*` }];
  },
};
export default config;
