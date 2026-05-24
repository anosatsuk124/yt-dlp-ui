import type { Metadata } from "next";
import "./globals.css";
import { Nav } from "@/components/nav";
import { Toaster } from "@/components/ui/toaster";

export const metadata: Metadata = {
  title: "yt-dlp-ui",
  description: "Web UI for yt-dlp",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <Nav />
        <main className="container mx-auto p-4">{children}</main>
        <Toaster />
      </body>
    </html>
  );
}
