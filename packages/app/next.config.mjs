import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  compress: true,
  productionBrowserSourceMaps: false,
  // protocol/engine are imported as TypeScript source from sibling packages
  experimental: {
    externalDir: true,
  },
  images: {
    formats: ["image/avif", "image/webp"],
    deviceSizes: [360, 640, 828, 1200, 1920],
    imageSizes: [16, 32, 48, 64, 96, 128, 256, 384],
    minimumCacheTTL: 60 * 60 * 24 * 365, // 1 year for static assets
  },
  headers: async () => [
    {
      source: "/:path*",
      headers: [
        {
          key: "Cache-Control",
          value: "public, max-age=31536000, immutable",
        },
      ],
      has: [
        {
          type: "query",
          key: "_next",
        },
      ],
    },
    {
      source: "/static/:path*",
      headers: [
        {
          key: "Cache-Control",
          value: "public, max-age=31536000, immutable",
        },
      ],
    },
  ],
  webpack: (config) => {
    // allow ".js" import specifiers to resolve to ".ts"/".tsx" sources
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js", ".jsx"],
    };
    // sibling packages (protocol/engine) resolve their own deps relative to
    // their own location; node's resolution climbs from there, but npm
    // workspace hoisting can land a dep in this package's node_modules only,
    // which is outside that climb. Make this package's node_modules (and the
    // workspace root's) explicit resolution roots so it's found either way.
    config.resolve.modules = [
      path.resolve(__dirname, "node_modules"),
      path.resolve(__dirname, "../../node_modules"),
      "node_modules",
    ];
    return config;
  },
};

export default nextConfig;
