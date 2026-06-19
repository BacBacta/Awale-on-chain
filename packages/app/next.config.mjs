import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // protocol/engine are imported as TypeScript source from sibling packages
  experimental: {
    externalDir: true,
    // trace from the repo root so deployments (Vercel) bundle the sibling
    // packages that server components import (indexer -> protocol)
    outputFileTracingRoot: repoRoot,
  },
  webpack: (config) => {
    // allow ".js" import specifiers to resolve to ".ts"/".tsx" sources
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js", ".jsx"],
    };
    return config;
  },
};

export default nextConfig;
