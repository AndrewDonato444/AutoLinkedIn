import dotenv from 'dotenv';
import path from 'path';
import { RateLimiter } from './rate-limiter.js';
import {
  AuthError,
  ConfigError,
  Http404Error,
  NotFoundError,
  ServerError,
  TimeoutError,
  ValidationError,
} from './errors.js';
import type {
  Campaign,
  CreateLeadInput,
  GojiBerryClientConfig,
  Lead,
  LeadFilters,
  List,
  ListWithLeads,
  PaginatedLeads,
  UpdateLeadInput,
} from './types.js';

// Load .env.local from project root (cwd when scripts run)
dotenv.config({ path: path.join(process.cwd(), '.env.local') });

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class GojiBerryClient {
  private static readonly MAX_RETRIES = 3;
  private static readonly RETRY_BASE_DELAY_MS = 1_000;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly rateLimiter: RateLimiter;

  constructor(config: GojiBerryClientConfig = {}) {
    const apiKey = config.apiKey ?? process.env.GOJIBERRY_API_KEY;
    if (!apiKey) {
      throw new ConfigError();
    }

    this.apiKey = apiKey;
    this.baseUrl =
      config.baseUrl ?? process.env.GOJIBERRY_BASE_URL ?? 'https://ext.gojiberry.ai';
    this.timeoutMs = config.timeoutMs ?? Number(process.env.GOJIBERRY_TIMEOUT_MS ?? 30_000);
    const rateLimit = config.rateLimit ?? Number(process.env.GOJIBERRY_RATE_LIMIT ?? 100);
    this.rateLimiter = new RateLimiter(rateLimit);
  }

  private get headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    };
  }

  private async request<T>(
    method: string,
    urlPath: string,
    body?: unknown,
    retriesLeft = GojiBerryClient.MAX_RETRIES,
  ): Promise<T> {
    await this.rateLimiter.throttle();

    const url = `${this.baseUrl}${urlPath}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: this.headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (err: unknown) {
      clearTimeout(timeoutId);
      if (err instanceof Error && err.name === 'AbortError') {
        throw new TimeoutError();
      }
      throw err;
    }
    clearTimeout(timeoutId);

    if (response.status === 401) {
      throw new AuthError();
    }

    if (response.status === 404) {
      throw new Http404Error(urlPath);
    }

    if (response.status >= 500 && response.status <= 503) {
      if (retriesLeft > 0) {
        const attempt = GojiBerryClient.MAX_RETRIES - retriesLeft; // 0, 1, 2
        const delayMs = GojiBerryClient.RETRY_BASE_DELAY_MS * Math.pow(2, attempt); // 1s, 2s, 4s
        await sleep(delayMs);
        return this.request<T>(method, urlPath, body, retriesLeft - 1);
      }
      throw new ServerError();
    }

    if (!response.ok) {
      throw new Error(`GojiBerry API error: ${response.status} ${response.statusText}`);
    }

    return response.json() as Promise<T>;
  }

  private async getById<T>(urlPath: string, resourceName: string, id: string): Promise<T> {
    try {
      return await this.request<T>('GET', `${urlPath}/${id}`);
    } catch (err) {
      if (err instanceof Http404Error) {
        console.log(`${resourceName} ${id} not found in GojiBerry`);
        throw new NotFoundError(resourceName, id);
      }
      throw err;
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.request<unknown>('GET', '/health');
      console.log('Connected to GojiBerry');
      return true;
    } catch {
      console.error('Cannot reach GojiBerry API — check your internet and API key');
      return false;
    }
  }

  async createLead(lead: CreateLeadInput): Promise<Lead> {
    if (!lead.firstName || !lead.lastName || !lead.profileUrl) {
      throw new ValidationError('Lead requires firstName, lastName, and profileUrl');
    }

    const created = await this.request<Lead>('POST', '/v1/contact', lead);
    console.log(`Lead created: ${lead.firstName} ${lead.lastName}`);
    return created;
  }

  async getLead(id: string): Promise<Lead> {
    return this.getById<Lead>('/v1/contact', 'Lead', id);
  }

  async searchLeads(filters: LeadFilters = {}): Promise<PaginatedLeads> {
    const params = new URLSearchParams();
    if (filters.search) params.set('search', filters.search);
    if (filters.dateFrom) params.set('dateFrom', filters.dateFrom);
    if (filters.dateTo) params.set('dateTo', filters.dateTo);
    if (filters.scoreFrom !== undefined) params.set('scoreFrom', String(filters.scoreFrom));
    if (filters.scoreTo !== undefined) params.set('scoreTo', String(filters.scoreTo));
    if (filters.intentType) params.set('intentType', filters.intentType);
    if (filters.page !== undefined) params.set('page', String(filters.page));
    if (filters.pageSize !== undefined) params.set('pageSize', String(filters.pageSize));

    const query = params.toString();
    const urlPath = query ? `/v1/contact?${query}` : '/v1/contact';
    return this.request<PaginatedLeads>('GET', urlPath);
  }

  async updateLead(id: string, updates: UpdateLeadInput): Promise<Lead> {
    try {
      const updated = await this.request<Lead>('PATCH', `/v1/contact/${id}`, updates);
      console.log(`Lead updated: ${updated.firstName} ${updated.lastName}`);
      return updated;
    } catch (err) {
      if (err instanceof Http404Error) {
        console.log(`Lead ${id} not found in GojiBerry`);
        throw new NotFoundError('Lead', id);
      }
      throw err;
    }
  }

  async getIntentTypeCounts(): Promise<Record<string, number>> {
    return this.request<Record<string, number>>('GET', '/v1/contact/intent-type-counts');
  }

  async getCampaigns(options: { activeOnly?: boolean } = {}): Promise<Campaign[]> {
    const urlPath = options.activeOnly ? '/v1/campaign?activeOnly=true' : '/v1/campaign';
    return this.request<Campaign[]>('GET', urlPath);
  }

  async getCampaign(id: string): Promise<Campaign> {
    return this.getById<Campaign>('/v1/campaign', 'Campaign', id);
  }

  async getLists(): Promise<List[]> {
    return this.request<List[]>('GET', '/v1/list');
  }

  async getList(id: string): Promise<ListWithLeads> {
    return this.getById<ListWithLeads>('/v1/list', 'List', id);
  }
}

export default GojiBerryClient;
