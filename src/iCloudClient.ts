export class UnsuccessfulRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly method: string,
    readonly url: string
  ) {
    super(message);
    this.name = 'UnsuccessfulRequestError';
  }
}

export type ICloudAuthenticationFailureHandler = (
  error: UnsuccessfulRequestError
) => void | Promise<void>;

type ServiceName = 'premiummailsettings' | 'mccgateway';
export type ICloudWebservices = Partial<
  Record<ServiceName, { url: string; status: string }>
>;

export const DEFAULT_SETUP_URL = 'https://setup.icloud.com/setup/ws/1';
export const CN_SETUP_URL = 'https://setup.icloud.com.cn/setup/ws/1';

class ICloudClient {
  constructor(
    readonly setupUrl: typeof DEFAULT_SETUP_URL | typeof CN_SETUP_URL,
    public webservices?: ICloudWebservices,
    public dsid?: string,
    private readonly onAuthenticationFailure?: ICloudAuthenticationFailureHandler
  ) {}

  public async request(
    method: 'GET' | 'POST',
    url: string,
    options: {
      headers?: Record<string, string>;
      data?: Record<string, unknown>;
    } = {}
  ): Promise<unknown> {
    const { headers = {}, data = undefined } = options;
    const controller = new AbortController();
    const timeoutId = globalThis.setTimeout(() => controller.abort(), 15000);

    try {
      const response = await fetch(url, {
        method,
        headers,
        body: data !== undefined ? JSON.stringify(data) : undefined,
        credentials: 'include',
        signal: controller.signal,
      });

      if (!response.ok) {
        const requestError = new UnsuccessfulRequestError(
          `Request to ${method} ${url} failed with status code ${response.status}`,
          response.status,
          method,
          url
        );
        if (
          this.onAuthenticationFailure &&
          (response.status === 401 || response.status === 403)
        ) {
          try {
            await this.onAuthenticationFailure(requestError);
          } catch (handlerError) {
            console.debug('iCloud authentication-failure cleanup failed', handlerError);
          }
        }
        throw requestError;
      }
      return await response.json();
    } finally {
      globalThis.clearTimeout(timeoutId);
    }
  }

  public hasWebservice(serviceName: ServiceName): boolean {
    return Boolean(this.webservices?.[serviceName]?.url);
  }

  public webserviceUrl(serviceName: ServiceName): string {
    const service = this.webservices?.[serviceName];
    if (!service?.url) {
      throw new Error(`iCloud webservice '${serviceName}' is not available for this account.`);
    }
    return service.url;
  }

  public async isAuthenticated(): Promise<boolean> {
    try {
      await this.validateToken();
      return true;
    } catch {
      return false;
    }
  }

  public async validateToken(): Promise<void> {
    const response = (await this.request('POST', `${this.setupUrl}/validate`)) as {
      webservices?: ICloudWebservices;
      dsInfo?: { dsid?: string | number };
    };
    if (response.webservices) this.webservices = response.webservices;
    if (response.dsInfo?.dsid !== undefined) this.dsid = String(response.dsInfo.dsid);
  }

  public async signOut(
    options: { trust: boolean } = { trust: false }
  ): Promise<void> {
    const { trust } = options;
    await this.request('POST', `${this.setupUrl}/logout`, {
      data: { trustBrowsers: trust, allBrowsers: trust },
    }).catch(console.debug);
  }
}

export type HmeEmail = {
  origin: 'ON_DEMAND' | 'SAFARI';
  anonymousId: string;
  domain: string;
  forwardToEmail: string;
  hme: string;
  isActive: boolean;
  label: string;
  note: string;
  createTimestamp: number;
  recipientMailId: string;
};

export type ListHmeResult = {
  hmeEmails: HmeEmail[];
  selectedForwardTo: string;
  forwardToEmails: string[];
};

type PremiumMailSettingsResponse<T = unknown> = {
  success: boolean;
  result: T;
  error?: { errorMessage: string };
};

export class GenerateHmeException extends Error {}
export class ReserveHmeException extends Error {}
export class UpdateHmeMetadataException extends Error {}
export class DeactivateHmeException extends Error {}
export class ReactivateHmeException extends Error {}
export class DeleteHmeException extends Error {}
export class UpdateFwdToHmeException extends Error {}

export class PremiumMailSettings {
  private readonly baseUrl: string;
  private readonly v2BaseUrl: string;
  constructor(readonly client: ICloudClient) {
    this.baseUrl = `${client.webserviceUrl('premiummailsettings')}/v1`;
    this.v2BaseUrl = `${client.webserviceUrl('premiummailsettings')}/v2`;
  }

  async listHme(): Promise<ListHmeResult> {
    const { result } = (await this.client.request(
      'GET',
      `${this.v2BaseUrl}/hme/list`
    )) as PremiumMailSettingsResponse<ListHmeResult>;
    return result;
  }

  async generateHme(): Promise<string> {
    const response = (await this.client.request(
      'POST',
      `${this.baseUrl}/hme/generate`
    )) as PremiumMailSettingsResponse<{ hme: string }>;
    if (!response.success) throw new GenerateHmeException(response.error?.errorMessage);
    return response.result.hme;
  }

  async reserveHme(
    hme: string,
    label: string,
    note: string | undefined = 'Generated through Apple All-In-One'
  ): Promise<HmeEmail> {
    const response = (await this.client.request(
      'POST',
      `${this.baseUrl}/hme/reserve`,
      { data: { hme, label, note } }
    )) as PremiumMailSettingsResponse<{ hme: HmeEmail }>;
    if (!response.success) throw new ReserveHmeException(response.error?.errorMessage);
    return response.result.hme;
  }

  async updateHmeMetadata(
    anonymousId: string,
    label: string,
    note?: string
  ): Promise<void> {
    const response = (await this.client.request(
      'POST',
      `${this.baseUrl}/hme/updateMetaData`,
      { data: { anonymousId, label, note } }
    )) as PremiumMailSettingsResponse;
    if (!response.success) throw new UpdateHmeMetadataException('Failed to update HME metadata');
  }

  async deactivateHme(anonymousId: string): Promise<void> {
    const response = (await this.client.request(
      'POST', `${this.baseUrl}/hme/deactivate`, { data: { anonymousId } }
    )) as PremiumMailSettingsResponse;
    if (!response.success) throw new DeactivateHmeException('Failed to deactivate HME');
  }

  async reactivateHme(anonymousId: string): Promise<void> {
    const response = (await this.client.request(
      'POST', `${this.baseUrl}/hme/reactivate`, { data: { anonymousId } }
    )) as PremiumMailSettingsResponse;
    if (!response.success) throw new ReactivateHmeException('Failed to reactivate HME');
  }

  async deleteHme(anonymousId: string): Promise<void> {
    const response = (await this.client.request(
      'POST', `${this.baseUrl}/hme/delete`, { data: { anonymousId } }
    )) as PremiumMailSettingsResponse;
    if (!response.success) throw new DeleteHmeException('Failed to delete HME');
  }

  async updateForwardToHme(forwardToEmail: string): Promise<void> {
    const response = (await this.client.request(
      'POST', `${this.baseUrl}/hme/updateForwardTo`, { data: { forwardToEmail } }
    )) as PremiumMailSettingsResponse;
    if (!response.success) {
      throw new UpdateFwdToHmeException('Failed to update the Forward To email.');
    }
  }
}

export default ICloudClient;
