import type { Metadata } from "next";
import "./globals.css";
import { CommandRunnerProvider } from "@/lib/command-runner";
import { OutputDrawer } from "@/components/asia/output-drawer";

export const metadata: Metadata = {
  title: "Asia Dashboard",
  description:
    "Asia morning-session trading dashboard. HSI today, Nikkei/Nifty later.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="bg-background text-foreground antialiased min-h-screen">
        <CommandRunnerProvider>
          {children}
          <OutputDrawer />
        </CommandRunnerProvider>
      </body>
    </html>
  );
}
