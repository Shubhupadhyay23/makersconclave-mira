import type { Metadata, Viewport } from "next";

export const metadata: Metadata = {
  title: "Mirrorless",
  description: "AI-powered smart mirror for personalized outfit recommendations",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
