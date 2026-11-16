import type { Metadata, Viewport } from "next";
import { cookies, headers } from "next/headers";
import { Geist, Geist_Mono } from "next/font/google";
import { ServiceWorkerRegistrar } from "@/components/layout/sw-registrar";
import { ThemeListener } from "@/components/layout/theme-listener";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  chooseThemePreference,
  parseThemePreference,
  THEME_COOKIE_NAME,
  themeBootstrapScript
} from "@/lib/theme";
import { savedThemePreference } from "@/server/theme-preference";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"]
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"]
});

export const metadata: Metadata = {
  title: { default: "Meridian", template: "%s · Meridian" },
  description: "Self-hosted personal finance. Know exactly where you stand.",
  robots: { index: false, follow: false }
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // One contract for every render: a valid browser (cookie) preference
  // wins; the signed-in user's saved preference initializes a missing
  // browser preference; "system" is the fallback.
  const browserPreference = parseThemePreference((await cookies()).get(THEME_COOKIE_NAME)?.value);
  const preference = chooseThemePreference(
    browserPreference,
    browserPreference ? null : await savedThemePreference()
  );
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <html
      lang="en"
      // Explicit preferences are painted by the server itself, so the
      // correct theme is in the initial HTML and survives router.refresh()
      // and server-action revalidation — previously the class existed only
      // as a client-side mutation by the bootstrap script, which React
      // reconciliation discarded on refresh, resetting the theme.
      // "system" cannot be resolved server-side; the nonce-protected
      // bootstrap below resolves it before paint.
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased${
        preference === "dark" ? " dark" : ""
      }`}
      suppressHydrationWarning
    >
      <head>
        <script
          nonce={nonce}
          dangerouslySetInnerHTML={{ __html: themeBootstrapScript(preference) }}
        />
      </head>
      <body className="min-h-full flex flex-col">
        <TooltipProvider>
          {children}
          <ThemeListener initialPreference={preference} />
          <ServiceWorkerRegistrar />
        </TooltipProvider>
      </body>
    </html>
  );
}
