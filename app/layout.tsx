import type { Metadata, Viewport } from "next";
import { Inter, Honk } from "next/font/google";
import { branding, brandingCssVariables } from "@/branding.config";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const honk = Honk({
  subsets: ["latin"],
  variable: "--font-honk",
  display: "swap",
});

export const metadata: Metadata = {
  title: `${branding.brand.name} · ${branding.brand.product}`,
  description: branding.brand.tagline,
  robots: { index: false, follow: false },
  appleWebApp: {
    title: branding.brand.product.toLowerCase(),
  },
};

export const viewport: Viewport = {
  themeColor: branding.surface.background,
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang={branding.brand.locale} className={`${inter.variable} ${honk.variable}`}>
      <head>
        <style dangerouslySetInnerHTML={{ __html: brandingCssVariables() }} />
      </head>
      <body className="min-h-screen font-sans antialiased">{children}</body>
    </html>
  );
}
