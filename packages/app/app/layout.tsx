import type { Metadata, Viewport } from "next";
import { Sora, Fraunces } from "next/font/google";
import "./globals.css";
import { BottomNav } from "../src/components/BottomNav.js";
import { Footer } from "../src/components/Footer.js";
import { RouteTransition } from "../src/components/RouteTransition.js";

// Modern, characterful pairing: Sora for UI + numerals, Fraunces for the brand
// wordmark and big display moments (warm, editorial — nods to the heritage).
const sora = Sora({ subsets: ["latin"], weight: ["400", "500", "600", "700", "800"], variable: "--font-ui", display: "swap" });
const fraunces = Fraunces({ subsets: ["latin"], weight: ["600", "700", "800", "900"], variable: "--font-display", display: "swap" });

export const metadata: Metadata = {
  title: "Awalé",
  description: "Play Awalé and win real money — right in MiniPay.",
  // Discover/listing + home-screen icon (MiniPay listing requires them)
  manifest: "/manifest.webmanifest",
  icons: { icon: "/icon.svg", apple: "/icon.svg" },
  // Talent Protocol / talentapp project-ownership verification tag
  other: {
    "talentapp:project_verification":
      "752849dfa6995b98e2390869978d90a693ca4172addff158af5c14031ccf9a0977fd3d266919960aee8db71e6453787e1b2ba20f8960c0892b30f4b7d25f485f",
  },
};

export const viewport: Viewport = {
  // device-width (not a fixed 360) so it reflows on narrower phones; zoom is
  // left ENABLED — disabling it fails WCAG 2.2 SC 1.4.4 (Resize Text)
  width: "device-width",
  initialScale: 1,
  themeColor: "#060504",
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sora.variable} ${fraunces.variable}`}>
      <head>
        {/* LCP is the hero board's seed sprite; the board only mounts after
            hydration, so preload the sprite at high priority to remove its
            fetch from the LCP critical path (PageSpeed: fetchpriority=high). */}
        <link rel="preload" as="image" href="/assets/seed.webp" fetchPriority="high" />
        <link rel="preload" as="image" href="/assets/wood.webp" />
      </head>
      <body>
        <div className="frame">
          <RouteTransition>{children}</RouteTransition>
          <Footer />
          <BottomNav />
        </div>
      </body>
    </html>
  );
}
