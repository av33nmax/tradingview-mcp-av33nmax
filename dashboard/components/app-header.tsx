"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { SessionClock } from "@/components/session-clock";
import { Crosshair } from "lucide-react";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/",              label: "Dashboard" },
  { href: "/how-it-works",  label: "How it works" },
];

export function AppHeader() {
  const pathname = usePathname();

  return (
    <header
      className="border-b border-zinc-800/80 bg-zinc-950/70 backdrop-blur sticky top-0 z-30"
      style={{ paddingTop: "env(safe-area-inset-top)" }}
    >
      <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-3 md:flex-row md:items-center md:justify-between md:gap-6 md:px-6 md:py-4">
        {/* Logo + mobile clock row */}
        <div className="flex items-center justify-between gap-4 md:gap-6">
          <Link href="/" className="flex items-center gap-3 transition-opacity hover:opacity-80">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-orange-500 to-rose-500 text-white">
              <Crosshair className="h-5 w-5" />
            </div>
            <div className="flex flex-col min-w-0">
              <h1 className="text-base md:text-lg font-semibold tracking-tight leading-none truncate">
                Cro<span className="text-emerald-400">$$</span>hair ZeroOne
              </h1>
              <p className="hidden md:block text-xs text-muted-foreground mt-0.5">
                Systematic 0DTE trader&apos;s co-pilot
              </p>
            </div>
          </Link>

          {/* Desktop nav */}
          <nav className="hidden md:flex items-center gap-1 border-l border-zinc-800 pl-6">
            {NAV.map((item) => {
              const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    "px-3 py-1.5 rounded-md text-sm transition-colors",
                    active
                      ? "bg-zinc-800/70 text-foreground"
                      : "text-muted-foreground hover:text-foreground hover:bg-zinc-800/40",
                  )}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>

          {/* Mobile-only clock on the right */}
          <div className="md:hidden shrink-0">
            <SessionClock compact />
          </div>
        </div>

        {/* Desktop clock */}
        <div className="hidden md:block">
          <SessionClock />
        </div>
      </div>

      {/* Mobile nav — bottom row */}
      <nav className="md:hidden flex items-center gap-1 border-t border-zinc-800 px-4 py-2">
        {NAV.map((item) => {
          const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "min-h-[44px] flex items-center px-3 py-2 rounded-md text-sm transition-colors",
                active
                  ? "bg-zinc-800/70 text-foreground"
                  : "text-muted-foreground active:bg-zinc-800/40",
              )}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>
    </header>
  );
}
