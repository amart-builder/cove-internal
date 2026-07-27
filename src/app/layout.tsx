import type { Metadata } from "next";
import Script from "next/script";
import "./globals.css";
import ConvexClientProvider from "./ConvexClientProvider";
import TabNav from "@/components/layout/TabNav";
import { BuddyProvider } from "@/components/buddy/BuddyProvider";
import BuddyDock from "@/components/buddy/BuddyDock";

export const metadata: Metadata = {
  title: "Forge",
  description: "Tasks, Email, and CRM - your local command center",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full" suppressHydrationWarning>
      <body className="h-full flex flex-col">
        <Script id="theme-detection" strategy="beforeInteractive">
          {`(function(){try{var t=localStorage.getItem('theme');if(t==='dark'||(!t&&matchMedia('(prefers-color-scheme:dark)').matches))document.documentElement.classList.add('dark')}catch(e){}})()`}
        </Script>
        <ConvexClientProvider>
          <BuddyProvider>
            <TabNav />
            <main className="flex-1 overflow-hidden">
              {children}
            </main>
            <BuddyDock />
          </BuddyProvider>
        </ConvexClientProvider>
      </body>
    </html>
  );
}
