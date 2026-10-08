import { useCallback, useEffect, useRef, useState } from 'react';
import browser from 'webextension-polyfill';
import {
  defaultPopupNavigation,
  popupNavigationStorageKey,
  sanitizePopupNavigation,
  type PopupNavigation,
  type PopupNavigationContext,
} from './popup-navigation';

type Options = PopupNavigationContext & {
  accountLoading: boolean;
  legacyLoading: boolean;
};
type HydratedNavigation = {
  key: string;
  accountKey: string;
  navigation: PopupNavigation;
};

const NAVIGATION_READ_TIMEOUT_MS = 3000;

const sameNavigation = (left: PopupNavigation, right: PopupNavigation) =>
  JSON.stringify(left) === JSON.stringify(right);

const persist = (key: string, navigation: PopupNavigation) => {
  // Issue immediately: toolbar popups can close before a debounce or cleanup runs.
  try {
    void browser.storage.local.set({ [key]: navigation }).catch(() => {});
  } catch {
    // Navigation remains usable if extension storage is temporarily unavailable.
  }
};

export function usePopupNavigation(options: Options) {
  const key = popupNavigationStorageKey(options.isManager);
  const [hydrated, setHydrated] = useState<HydratedNavigation>();
  const current = useRef<HydratedNavigation | undefined>(undefined);
  const latestOptions = useRef(options);
  latestOptions.current = options;
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    if (options.accountLoading || options.legacyLoading) return;
    let cancelled = false;
    let readTimer: ReturnType<typeof setTimeout> | undefined;
    let finishRead: (() => void) | undefined;

    const previous = current.current;
    if (previous?.key === key) {
      const navigation = sanitizePopupNavigation(previous.navigation, options);
      if (previous.accountKey !== options.accountKey || !sameNavigation(previous.navigation, navigation)) {
        const next = { key, accountKey: options.accountKey, navigation };
        current.current = next;
        setHydrated(next);
        if (!sameNavigation(previous.navigation, navigation)) persist(key, navigation);
      }
      return;
    }

    const restore = async () => {
      let saved: unknown;
      try {
        const fallback = new Promise<undefined>((resolve) => {
          finishRead = () => resolve(undefined);
          readTimer = setTimeout(finishRead, NAVIGATION_READ_TIMEOUT_MS);
        });
        // A stalled storage read must not leave the entire popup on a spinner.
        // Once fallback wins, a late response can never replace user navigation.
        const stored = await Promise.race([browser.storage.local.get(key), fallback]);
        saved = stored?.[key];
      } catch {
        // Default to the existing legacy page without blocking the popup.
      } finally {
        clearTimeout(readTimer);
      }
      if (cancelled) return;
      const navigation = sanitizePopupNavigation(saved, options);
      const next = { key, accountKey: options.accountKey, navigation };
      current.current = next;
      setHydrated(next);
      // Remove stale cross-account details and unexpected persisted fields.
      // A brand-new installation is not written until the user navigates.
      if (saved !== undefined && JSON.stringify(saved) !== JSON.stringify(navigation)) persist(key, navigation);
    };
    void restore();
    return () => {
      cancelled = true;
      clearTimeout(readTimer);
      finishRead?.();
    };
  }, [key, options.accountKey, options.accountLoading, options.legacyLoading, options.legacyManaging, options.isManager]);

  const navigate = useCallback((patch: Partial<PopupNavigation>) => {
    const context = latestOptions.current;
    const previous = current.current;
    const currentKey = popupNavigationStorageKey(context.isManager);
    if (
      !mounted.current || context.accountLoading || context.legacyLoading ||
      !previous || previous.key !== currentKey || previous.accountKey !== context.accountKey
    ) return;
    const navigation = sanitizePopupNavigation({ ...previous.navigation, ...patch, version: 1 }, context);
    if (sameNavigation(previous.navigation, navigation)) return;
    const next = { key: currentKey, accountKey: context.accountKey, navigation };
    current.current = next;
    setHydrated(next);
    persist(currentKey, navigation);
  }, []);

  const ready = !options.accountLoading && !options.legacyLoading &&
    hydrated?.key === key && hydrated.accountKey === options.accountKey;
  const navigation = hydrated?.key === key
    ? sanitizePopupNavigation(hydrated.navigation, options)
    : defaultPopupNavigation(options);

  return { ready, navigation, navigate };
}
