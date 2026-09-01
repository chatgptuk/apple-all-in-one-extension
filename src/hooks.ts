import browser from 'webextension-polyfill';
import {
  Dispatch,
  useEffect,
  useState,
  SetStateAction,
  useCallback,
} from 'react';
import {
  getBrowserStorageValue,
  setBrowserStorageValue,
  Store,
} from './storage';

export function useBrowserStorageState<K extends keyof Store>(
  key: K,
  initialValue: Store[K]
): [Store[K], Dispatch<SetStateAction<Store[K]>>, boolean] {
  const [state, setState] = useState(initialValue);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let mounted = true;

    async function getBrowserStorageState() {
      setIsLoading(true);
      const value = await getBrowserStorageValue(key);
      if (!mounted) return;
      setState(value !== undefined ? value : initialValue);
    }

    const onChanged = (
      changes: Record<string, browser.Storage.StorageChange>,
      areaName: string
    ) => {
      if (!mounted || areaName !== 'local') return;
      const change = changes[String(key)];
      if (!change) return;
      setState((change.newValue !== undefined ? change.newValue : initialValue) as Store[K]);
    };

    browser.storage.onChanged.addListener(onChanged);
    getBrowserStorageState()
      .catch(console.error)
      .finally(() => {
        if (mounted) setIsLoading(false);
      });

    return () => {
      mounted = false;
      browser.storage.onChanged.removeListener(onChanged);
    };
  }, [key, initialValue]);

  const setBrowserStorageState = useCallback(
    (value: SetStateAction<Store[K]>) =>
      setState((prevState) => {
        const newValue = value instanceof Function ? value(prevState) : value;
        setBrowserStorageValue(key, newValue);
        return newValue;
      }),
    [key]
  );

  return [state, setBrowserStorageState, isLoading];
}
