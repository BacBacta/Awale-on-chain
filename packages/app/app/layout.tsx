import type { Metadata, Viewport } from "next";
import { Sora, Fraunces } from "next/font/google";
import "./globals.css";

// Modern, characterful pairing: Sora for UI + numerals, Fraunces for the brand
// wordmark and big display moments (warm, editorial — nods to the heritage).
const sora = Sora({ subsets: ["latin"], weight: ["400", "500", "600", "700", "800"], variable: "--font-ui", display: "swap" });
const fraunces = Fraunces({ subsets: ["latin"], weight: ["600", "700", "800", "900"], variable: "--font-display", display: "swap" });

export const metadata: Metadata = {
  title: "Awalé",
  description: "Play Awalé for stablecoin stakes on MiniPay.",
};

export const viewport: Viewport = {
  width: 360,
  initialScale: 1,
  maximumScale: 1,
  themeColor: "#0d100c",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sora.variable} ${fraunces.variable}`}>
      <body>
        <div className="frame">{children}</div>
      </body>
    </html>
  );
}
