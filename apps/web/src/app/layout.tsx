import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Providers } from "../features/auth/session-provider";
import { WorkspaceStateProvider } from "../providers/workspace-state";
import "../styles/globals.css";
import "../styles/onboarding.css";
import "../styles/desk.css";
import "../styles/themes.css";
import { OnboardingProvider } from "../features/onboarding/onboarding-provider";
import { ThemeProvider } from "../providers/theme-provider";

export const metadata: Metadata = {
  title: "Mandate — Your trading workspace",
  description: "A quieter workspace for onchain stocks and trading rules.",
};
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('mandate:theme');var d=t==='dark'||(t!=='light'&&matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.dataset.theme=d?'dark':'light';document.documentElement.style.colorScheme=d?'dark':'light';}catch(e){}})();`,
          }}
        />
        <ThemeProvider>
          <Providers>
            <OnboardingProvider>
              <WorkspaceStateProvider>{children}</WorkspaceStateProvider>
            </OnboardingProvider>
          </Providers>
        </ThemeProvider>
      </body>
    </html>
  );
}
