import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // protocol/engine are imported as TypeScript source from sibling packages
  experimental: {
    externalDir: true,
  },
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
