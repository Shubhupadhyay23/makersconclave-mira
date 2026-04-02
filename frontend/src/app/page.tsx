"use client";

import Link from "next/link";

const SOCKET_URL = process.env.NEXT_PUBLIC_SOCKET_URL || "not configured";

const routes = [
  {
    href: "/chat",
    label: "Chat with Mira",
    description: "Test UI — text-based agent conversation",
  },
  {
    href: "/mirror",
    label: "Mirror Display",
    description: "Full-screen overlay for the two-way mirror",
  },
  {
    href: "/phone",
    label: "Phone Onboarding",
    description: "Google OAuth sign-in and queue flow",
  },
];

export default function Home() {
  return (
    <main className="landing-bg min-h-screen flex items-center justify-center">
      <div className="landing-content flex flex-col items-center text-center">

        <h1 className="text-8xl md:text-9xl font-bold mb-4 tracking-widest bg-gradient-to-r from-purple-400 via-blue-400 to-cyan-400 bg-clip-text text-transparent">
          MIRA
        </h1>

        <p className="text-gray-300 mb-12 text-xl tracking-wide">
          AI Smart Mirror Assistant
        </p>
        <nav className="flex flex-col gap-6 w-full max-w-md">
          {routes.map((route) => (
            <Link
              key={route.href}
              href={route.href}
              className="glass-card p-6 text-white"
            >
              <div className="font-semibold text-xl mb-1">
                {route.label}
              </div>
              <div className="text-sm text-gray-300">
                {route.description}
              </div>
            </Link>
          ))}
        </nav>

        <div className="mt-10 text-sm text-gray-400 flex items-center gap-2">
          <span className="w-2 h-2 bg-green-500 rounded-full"></span>
          Socket: {SOCKET_URL}
        </div>

      </div>
    </main>
  );
}
