import script from './script';

const HME_CONTENT_READY_KEY = '__appleAllInOneHmeContentReady';
const contentScope = globalThis as typeof globalThis & Record<string, unknown>;

if (!contentScope[HME_CONTENT_READY_KEY]) {
  contentScope[HME_CONTENT_READY_KEY] = true;
  script().catch((error) => {
    contentScope[HME_CONTENT_READY_KEY] = false;
    console.error('[Apple All-In-One] Hide My Email content script failed', error);
  });
}
