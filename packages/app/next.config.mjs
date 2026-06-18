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
    return config;
  },
};

export default nextConfig;
