import axios, { type AxiosInstance, type AxiosRequestConfig } from 'axios';
import { loadConfig, saveConfig } from './config.js';
import type { Instance, OAuthAuth, QueryOptions, TableRecord } from '../types/index.js';

export class ServiceNowClient {
  private http: AxiosInstance;
  private instance: Instance;

  constructor(instance: Instance) {
    this.instance = instance;
    this.http = axios.create({
      baseURL: instance.url.replace(/\/$/, ''),
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
    });

    this.http.interceptors.request.use(async (config) => {
      config.headers = config.headers ?? {};
      if (this.instance.auth.type === 'basic') {
        const { username, password } = this.instance.auth;
        const encoded = Buffer.from(`${username}:${password}`).toString('base64');
        config.headers['Authorization'] = `Basic ${encoded}`;
      } else {
        const token = await this.getOAuthToken();
        config.headers['Authorization'] = `Bearer ${token}`;
      }
      return config;
    });

    this.http.interceptors.response.use(
      (res) => res,
      async (err) => {
        if (axios.isAxiosError(err)) {
          const status = err.response?.status;

          // Retry on rate-limit and transient server errors
          const retryable = status === 429 || status === 503 || status === 502;
          const config = err.config as (typeof err.config & { _retryCount?: number });

          if (retryable && config) {
            config._retryCount = (config._retryCount ?? 0) + 1;
            if (config._retryCount <= 3) {
              const retryAfterHeader = err.response?.headers['retry-after'];
              const baseDelay = 1000 * Math.pow(2, config._retryCount - 1); // 1s, 2s, 4s
              const delayMs = retryAfterHeader
                ? Math.max(parseInt(String(retryAfterHeader), 10) * 1000, baseDelay)
                : baseDelay;
              await new Promise((resolve) => setTimeout(resolve, delayMs));
              return this.http.request(config);
            }
            // All retries exhausted — include PDI quota hint
            const detail =
              (err.response?.data as { error?: { message?: string } })?.error?.message ?? err.message;
            return Promise.reject(
              new Error(
                `ServiceNow API error (${status}): ${detail}\n` +
                `Hint: PDI instances have lower transaction quotas. ` +
                `Wait a moment then retry, or reduce the number of artifacts per build.`
              )
            );
          }

          const detail =
            (err.response?.data as { error?: { message?: string } })?.error
              ?.message ?? err.message;
          return Promise.reject(new Error(`ServiceNow API error (${status}): ${detail}`));
        }
        return Promise.reject(err);
      }
    );
  }

  private async getOAuthToken(): Promise<string> {
    const auth = this.instance.auth as OAuthAuth;
    const now = Date.now();

    if (auth.accessToken && auth.tokenExpiry && auth.tokenExpiry > now + 30_000) {
      return auth.accessToken;
    }

    const params = new URLSearchParams({
      grant_type: 'password',
      client_id: auth.clientId,
      client_secret: auth.clientSecret,
    });

    const res = await axios.post<{ access_token: string; expires_in: number }>(
      `${this.instance.url.replace(/\/$/, '')}/oauth_token.do`,
      params.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    auth.accessToken = res.data.access_token;
    auth.tokenExpiry = now + res.data.expires_in * 1000;

    const config = loadConfig();
    config.instances[this.instance.alias].auth = auth;
    saveConfig(config);

    return auth.accessToken;
  }

  async get<T = unknown>(path: string, config?: AxiosRequestConfig): Promise<T> {
    const res = await this.http.get<T>(path, config);
    return res.data;
  }

  async post<T = unknown>(path: string, data?: unknown, config?: AxiosRequestConfig): Promise<T> {
    const res = await this.http.post<T>(path, data, config);
    return res.data;
  }

  async put<T = unknown>(path: string, data?: unknown, config?: AxiosRequestConfig): Promise<T> {
    const res = await this.http.put<T>(path, data, config);
    return res.data;
  }

  async patch<T = unknown>(path: string, data?: unknown, config?: AxiosRequestConfig): Promise<T> {
    const res = await this.http.patch<T>(path, data, config);
    return res.data;
  }

  async delete<T = unknown>(path: string, config?: AxiosRequestConfig): Promise<T> {
    const res = await this.http.delete<T>(path, config);
    return res.data;
  }

  // Table API helpers
  async queryTable(table: string, options: QueryOptions = {}): Promise<TableRecord[]> {
    const params: Record<string, string | number | boolean> = {};
    if (options.sysparmQuery) params['sysparm_query'] = options.sysparmQuery;
    if (options.sysparmFields) params['sysparm_fields'] = options.sysparmFields;
    if (options.sysparmLimit !== undefined) params['sysparm_limit'] = options.sysparmLimit;
    if (options.sysparmOffset !== undefined) params['sysparm_offset'] = options.sysparmOffset;
    if (options.sysparmDisplayValue !== undefined)
      params['sysparm_display_value'] = String(options.sysparmDisplayValue);
    if (options.sysparmExcludeReferenceLink !== undefined)
      params['sysparm_exclude_reference_link'] = options.sysparmExcludeReferenceLink;

    const res = await this.get<{ result: TableRecord[] }>(
      `/api/now/table/${table}`,
      { params }
    );
    return res.result;
  }

  async getRecord(table: string, sysId: string, options: QueryOptions = {}): Promise<TableRecord> {
    const params: Record<string, string | boolean> = {};
    if (options.sysparmFields) params['sysparm_fields'] = options.sysparmFields;
    if (options.sysparmDisplayValue !== undefined)
      params['sysparm_display_value'] = String(options.sysparmDisplayValue);

    const res = await this.get<{ result: TableRecord }>(
      `/api/now/table/${table}/${sysId}`,
      { params }
    );
    return res.result;
  }

  async createRecord(table: string, data: Record<string, unknown>): Promise<TableRecord> {
    const res = await this.post<{ result: TableRecord }>(`/api/now/table/${table}`, data);
    return res.result;
  }

  async updateRecord(
    table: string,
    sysId: string,
    data: Record<string, unknown>
  ): Promise<TableRecord> {
    const res = await this.patch<{ result: TableRecord }>(
      `/api/now/table/${table}/${sysId}`,
      data
    );
    return res.result;
  }

  async deleteRecord(table: string, sysId: string): Promise<void> {
    await this.delete(`/api/now/table/${table}/${sysId}`);
  }

  async getTableSchema(table: string): Promise<unknown> {
    const res = await this.get<unknown>(`/api/now/table/${table}?sysparm_limit=0`);
    return res;
  }

  getAxiosInstance(): AxiosInstance {
    return this.http;
  }

  getInstanceUrl(): string {
    return this.instance.url.replace(/\/$/, '');
  }
}
