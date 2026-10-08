export type PopupNavigation = {
  version: 1;
  appSection: 'passwords' | 'hide-email';
  hmeView: 'generate' | 'manage' | 'details';
  accountKey?: string;
  anonymousId?: string;
};

export type PopupNavigationContext = {
  isManager: boolean;
  accountKey: string;
  legacyManaging: boolean;
};

export const popupNavigationStorageKey = (isManager: boolean) =>
  isManager ? 'popupNavigation:manager:v1' : 'popupNavigation:toolbar:v1';

export function defaultPopupNavigation(context: PopupNavigationContext): PopupNavigation {
  return {
    version: 1,
    appSection: context.isManager ? 'hide-email' : 'passwords',
    hmeView: context.isManager || context.legacyManaging ? 'manage' : 'generate',
  };
}

/** Only navigation identifiers belong on disk, never an address or password payload. */
export function sanitizePopupNavigation(
  value: unknown,
  context: PopupNavigationContext
): PopupNavigation {
  const defaults = defaultPopupNavigation(context);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return defaults;
  const candidate = value as Partial<PopupNavigation>;
  if (candidate.version !== 1) return defaults;
  const navigation: PopupNavigation = {
    version: 1,
    appSection: context.isManager ? 'hide-email'
      : candidate.appSection === 'hide-email' || candidate.appSection === 'passwords'
        ? candidate.appSection : defaults.appSection,
    hmeView: candidate.hmeView === 'manage' || candidate.hmeView === 'generate' || candidate.hmeView === 'details'
      ? candidate.hmeView : defaults.hmeView,
  };
  if (navigation.hmeView === 'details') {
    const id = candidate.anonymousId;
    if (
      context.accountKey && context.accountKey.length <= 2048 &&
      candidate.accountKey === context.accountKey &&
      typeof id === 'string' && id.length <= 255 && id.trim() &&
      !/[\u0000-\u001f\u007f]/.test(id)
    ) {
      navigation.accountKey = context.accountKey;
      navigation.anonymousId = id;
    } else {
      navigation.hmeView = 'manage';
    }
  }
  return navigation;
}
