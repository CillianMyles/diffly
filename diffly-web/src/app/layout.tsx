import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "diffly web",
  description: "Browser CSV diff powered by worker + Rust WASM",
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
