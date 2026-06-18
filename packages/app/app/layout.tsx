import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Awalé",
  description: "Play Awalé for stablecoin stakes on MiniPay.",
};

export const viewport: Viewport = {
  width: 360,
  initialScale: 1,
  maximumScale: 1,
  themeColor: "#0f1410",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="frame">{children}</div>
      </body>
    </html>
  );
}
