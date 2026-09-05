import { useEffect, useRef, useState } from 'react';
import browser from 'webextension-polyfill';
import type ICloudClient from './iCloudClient';
import type { HmeEmail } from './iCloudClient';
import { ManagedPremiumMailSettings } from './hmeService';
import { hmeListCacheKey, type HmeListSnapshot } from './hmeRepository';

export function useHmeList(client: ICloudClient, refreshKey: number) {
  const [emails, setEmails] = useState<HmeEmail[]>();
  const [forwardTo, setForwardTo] = useState<string>();
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [manualRefresh, setManualRefresh] = useState(0);
  const consumedRefresh = useRef(0);
  useEffect(() => {
    let cancelled = false;
    let revision = 0;
    const service = new ManagedPremiumMailSettings(client);
    const force = consumedRefresh.current !== manualRefresh;
    consumedRefresh.current = manualRefresh;
    const apply = (snapshot?: HmeListSnapshot) => {
      if (cancelled || !snapshot) return;
      const sorted = [...snapshot.emails].sort(
        (a, b) => b.createTimestamp - a.createTimestamp
      );
      setEmails((previous) =>
        JSON.stringify(previous) === JSON.stringify(sorted) ? previous : sorted
      );
      setForwardTo(snapshot.forwardTo);
      setIsLoading(false);
    };
    const onChange = (message: unknown) => {
      const event = message as { type?: string; key?: string };
      if (
        event.type !== 'hme:list-changed' ||
        event.key !== hmeListCacheKey(client)
      )
        return undefined;
      const token = ++revision;
      service
        .snapshot()
        .then((snapshot) => {
          if (token === revision) apply(snapshot);
        })
        .catch(() => {});
      return undefined;
    };
    browser.runtime.onMessage.addListener(onChange);
    (async () => {
      try {
        apply(await service.snapshot());
        if (cancelled) return;
        setError(undefined);
        // The background coalesces requests and decides freshness; UI mount
        // counters are never part of the persisted cache's identity.
        await service.listHme(force);
        apply(await service.snapshot());
      } catch (e) {
        if (!cancelled) setError(String(e));
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      browser.runtime.onMessage.removeListener(onChange);
    };
  }, [client, refreshKey, manualRefresh]);
  return {
    emails,
    setEmails,
    forwardTo,
    isLoading,
    error,
    setError,
    refresh: () => setManualRefresh((n) => n + 1),
  };
}
