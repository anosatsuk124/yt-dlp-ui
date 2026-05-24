"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Download, List, Cookie, KeyRound, FileLock2, Settings } from "lucide-react";
import { cn } from "@/lib/utils";

const links = [
  { href: "/queue",    label: "Queue",       icon: Download },
  { href: "/history",  label: "History",     icon: List },
  { href: "/cookies",  label: "Cookies",     icon: Cookie },
  { href: "/auth",     label: "Credentials", icon: KeyRound },
  { href: "/certs",    label: "Certs",       icon: FileLock2 },
  { href: "/settings", label: "Settings",    icon: Settings },
];

export function Nav() {
  const pathname = usePathname();

  return (
    <nav className="border-b">
      <div className="container mx-auto flex h-14 items-center gap-1 px-4">
        <div className="mr-4 font-semibold">yt-dlp-ui</div>
        {links.map(({ href, label, icon: Icon }) => {
          const active = pathname === href || pathname?.startsWith(href + "/");
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                "inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                active
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
              )}
            >
              <Icon className="h-4 w-4" />
              {label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
