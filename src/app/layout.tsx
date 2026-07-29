import type { Metadata } from "next";
import "./globals.css";
import ConvexClientProvider from "./ConvexClientProvider";
import TabNav from "@/components/layout/TabNav";
import { BuddyProvider } from "@/components/buddy/BuddyProvider";
import BuddyDock from "@/components/buddy/BuddyDock";

export const metadata: Metadata = {
  title: "Cove",
  description: "Tasks, email, and people in your local command center",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full" suppressHydrationWarning>
      <head>
        {/* Runs before paint so a stored dark preference never flashes light.
            next/script with string children is inert in this Next version. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('theme');if(t==='dark'||(!t&&matchMedia('(prefers-color-scheme:dark)').matches))document.documentElement.classList.add('dark')}catch(e){}})()`,
          }}
        />
      </head>
      <body className="h-full flex flex-col">
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
