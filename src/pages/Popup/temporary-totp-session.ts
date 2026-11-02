import { createTotp, TotpError, type TotpErrorCode, type TotpGenerator, type TotpValue } from '../../passwords/totp';

export type TemporaryTotpState = {
  status: 'empty' | 'loading' | 'ready' | 'error';
  code?: string;
  seconds?: number;
  period?: number;
  error?: TotpErrorCode;
  copyNotice?: 'copied' | 'failed';
};

// One session per expanded tool. Only its owner holds the non-extractable key;
// disposal drops references and timers (not a JS heap-zeroization guarantee).
export function createTemporaryTotpSession(
  onChange: (state: TemporaryTotpState) => void,
  { prepare = createTotp, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {},
) {
  let generation = 0, disposed = false;
  let generator: TotpGenerator | undefined, value: TotpValue | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let copyNotice: TemporaryTotpState['copyNotice'];
  const current = (id: number) => !disposed && generation === id;
  const isLive = (item: TotpValue, time: number) => time >= item.startsAt && time < item.expiresAt;
  const cancel = () => {
    generation++;
    if (timer !== undefined) clearTimer(timer);
    timer = undefined; generator = undefined; value = undefined; copyNotice = undefined;
  };
  const ready = () => {
    if (value) onChange({ status: 'ready', code: value.code, seconds: Math.ceil((value.expiresAt - now()) / 1000), period: value.period, copyNotice });
  };
  const fail = (error: unknown) => {
    generator = undefined; value = undefined;
    onChange({ status: 'error', error: error instanceof TotpError ? error.code : 'unavailable' });
  };
  const tick = async (id: number) => {
    if (!current(id) || !generator) return;
    try {
      if (!value || !isLive(value, now())) {
        value = undefined; copyNotice = undefined;
        onChange({ status: 'loading' });
        const next = await generator.generate(now());
        if (!current(id)) return;
        // An async signature can cross a step boundary or a system clock change.
        if (isLive(next, now())) value = next;
      }
      ready();
      timer = setTimer(() => { void tick(id); }, 250);
    } catch (error) { if (current(id)) fail(error); }
  };
  return {
    async setInput(input: string) {
      if (disposed) return;
      cancel();
      const id = generation;
      if (!input.trim()) { onChange({ status: 'empty' }); return; }
      onChange({ status: 'loading' });
      try {
        const next = await prepare(input);
        if (!current(id)) return;
        generator = next;
        await tick(id);
      } catch (error) { if (current(id)) fail(error); }
    },
    async copy(write: (code: string) => Promise<void>) {
      const id = generation, active = generator;
      if (!active || !current(id)) return false;
      try {
        // Recalculate at click time, including after a throttled/background timer.
        const fresh = await active.generate(now());
        if (!current(id) || !isLive(fresh, now())) return false;
        await write(fresh.code);
        if (!current(id)) return true;
        copyNotice = 'copied';
        if (isLive(fresh, now())) { value = fresh; ready(); }
        return true;
      } catch {
        if (current(id)) { copyNotice = 'failed'; ready(); }
        return false;
      }
    },
    dispose() { cancel(); disposed = true; },
  };
}
