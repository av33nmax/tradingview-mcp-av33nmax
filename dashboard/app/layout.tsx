import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { CommandRunnerProvider } from "@/lib/command-runner";
import { OutputDrawer } from "@/components/output-drawer";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Cro$$hair ZeroOne",
  description: "Systematic 0DTE trader's co-pilot — bias, setups, discipline.",
  applicationName: "Cro$$hair ZeroOne",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Cro$$hair",
  },
  formatDetection: {
    telephone: false,
  },
};

export const viewport = {
  themeColor: "#0a0a0a",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover" as const,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased dark`}
    >
      <body className="min-h-full flex flex-col bg-background text-foreground">
        <CommandRunnerProvider>
          {children}
          <OutputDrawer />
        </CommandRunnerProvider>
      </body>
    </html>
  );
}
