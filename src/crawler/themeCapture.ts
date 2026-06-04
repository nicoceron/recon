import type { Page } from 'playwright';

export type ForcedTheme = 'light' | 'dark';

export async function installForcedTheme(page: Page, theme?: ForcedTheme): Promise<void> {
  if (!theme) return;
  await page.emulateMedia({ colorScheme: theme });
  await page.addInitScript(
    (forcedTheme) => {
      const apply = () => {
        const root = document.documentElement;
        if (!root) return;
        root.classList.remove('light', 'dark');
        root.classList.add('theme-root', forcedTheme);
        (window as Window & { __theme?: string }).__theme = forcedTheme;
      };
      try {
        localStorage.setItem('theme', forcedTheme);
      } catch {
        // Some documents disable storage access during early init.
      }
      apply();
    },
    theme,
  );
}

export async function applyForcedTheme(page: Page, theme?: ForcedTheme): Promise<void> {
  if (!theme) return;
  await page.emulateMedia({ colorScheme: theme }).catch(() => undefined);
  await page
    .evaluate((forcedTheme) => {
      const root = document.documentElement;
      root.classList.remove('light', 'dark');
      root.classList.add('theme-root', forcedTheme);
      (window as Window & { __theme?: string }).__theme = forcedTheme;
    }, theme)
    .catch(() => undefined);
}
