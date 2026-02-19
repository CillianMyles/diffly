import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Diffly",
  description: "Performant local CSV diffing, in your browser, powered by Rust WASM and workers",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
