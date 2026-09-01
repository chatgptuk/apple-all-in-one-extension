import browser from 'webextension-polyfill';

export type LanguagePreference = 'auto' | 'en' | 'zh-CN';
export type ResolvedLanguage = 'en' | 'zh-CN';

function uiLanguage(): string {
  try {
    return browser.i18n?.getUILanguage?.() ||
      (typeof navigator !== 'undefined' ? navigator.language : 'en') ||
      'en';
  } catch {
    return typeof navigator !== 'undefined' ? navigator.language : 'en';
  }
}

let resolvedLanguage: ResolvedLanguage = resolveLanguage('auto');

export function resolveLanguage(
  preference: LanguagePreference = 'auto',
  browserLanguage: string = uiLanguage()
): ResolvedLanguage {
  if (preference === 'zh-CN') return 'zh-CN';
  if (preference === 'en') return 'en';
  return /^zh(?:-|$)/i.test(browserLanguage) ? 'zh-CN' : 'en';
}

export async function initializeI18n(): Promise<ResolvedLanguage> {
  try {
    const stored = await browser.storage.local.get('languagePreference');
    resolvedLanguage = resolveLanguage((stored.languagePreference as LanguagePreference | undefined) || 'auto');
  } catch {
    resolvedLanguage = resolveLanguage('auto');
  }

  if (typeof document !== 'undefined') {
    document.documentElement.lang = resolvedLanguage === 'zh-CN' ? 'zh-CN' : 'en';
  }
  return resolvedLanguage;
}

export function getResolvedLanguage(): ResolvedLanguage {
  return resolvedLanguage;
}

export function tr(english: string, chinese: string): string {
  return resolvedLanguage === 'zh-CN' ? chinese : english;
}

export function trn(
  count: number,
  englishSingular: string,
  englishPlural: string,
  chinese: string
): string {
  if (resolvedLanguage === 'zh-CN') return chinese.replace('{count}', String(count));
  return (count === 1 ? englishSingular : englishPlural).replace('{count}', String(count));
}

export async function setLanguagePreference(preference: LanguagePreference): Promise<void> {
  await browser.storage.local.set({ languagePreference: preference });
  resolvedLanguage = resolveLanguage(preference);
}
