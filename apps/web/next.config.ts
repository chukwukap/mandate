import type { NextConfig } from "next";

const config: NextConfig = {
  poweredByHeader: false,
  devIndicators: false,
  transpilePackages: ["@mandate/contracts"],
  async rewrites() {
    const origin = process.env.MANDATE_API_URL ?? "http://127.0.0.1:8080";
    return [{ source: "/api/mandate/:path*", destination: `${origin}/:path*` }];
  },
};
export default config;
