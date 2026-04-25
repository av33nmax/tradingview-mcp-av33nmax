"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { SessionClock } from "@/components/session-clock";
import { ModeBadge } from "@/components/mode-badge";
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
      className="sticky top-0 z-30 border-b border-white/[0.06] bg-[#09090b]/85 backdrop-blur-xl"
      style={{ paddingTop: "env(safe-area-inset-top)" }}
    >
      <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-3 md:flex-row md:items-center md:justify-between md:gap-6 md:px-6 md:py-4">
        <div className="flex items-center justify-between gap-4 md:gap-6">
          <Link href="/" className="flex items-center gap-3 transition-opacity hover:opacity-80">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-[#c8a978] to-[#8b5a2b] text-[#09090b] shadow-[0_0_0_1px_rgba(200,169,120,0.3),0_2px_8px_rgba(200,169,120,0.2)]">
              <Crosshair className="h-5 w-5" strokeWidth={2.25} />
            </div>
            <div className="flex flex-col min-w-0">
              <div className="flex items-center gap-2">
                <h1 className="text-base md:text-lg font-semibold tracking-tight leading-none truncate text-[#e4e4e7]">
                  Cro<span className="text-[#c8a978]">$$</span>hair ZeroOne
                </h1>
                <ModeBadge />
              </div>
              <p className="hidden md:block text-[13px] text-[#71717a] mt-1">
                Systematic 0DTE trader&apos;s co-pilot
              </p>
            </div>
          </Link>

          {/* Desktop nav */}
          <nav className="hidden md:flex items-center gap-1 md:ml-4 md:border-l md:border-white/[0.06] md:pl-6">
            {NAV.map((item) => {
              const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    "px-3 py-1.5 rounded-md text-sm transition-colors",
                    active
                      ? "bg-white/[0.06] text-[#e4e4e7] font-medium"
                      : "text-[#a1a1aa] hover:text-[#e4e4e7] hover:bg-white/[0.04]",
                  )}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>

          <div className="md:hidden shrink-0">
            <SessionClock compact />
          </div>
        </div>

        <div className="hidden md:block">
          <SessionClock />
        </div>
      </div>

      <nav className="md:hidden flex items-center gap-1 border-t border-white/[0.06] px-4 py-2">
        {NAV.map((item) => {
          const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "min-h-[44px] flex items-center px-3 py-2 rounded-md text-sm transition-colors",
                active
                  ? "bg-white/[0.06] text-[#e4e4e7] font-medium"
                  : "text-[#a1a1aa] active:bg-white/[0.04]",
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
