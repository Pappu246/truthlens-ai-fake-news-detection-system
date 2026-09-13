import { NewsFeedResponse } from '../../src/types';
import { FetchNewsOptions, NewsProvider } from './types';
import { RSSNewsProvider } from './rssProvider';

interface CacheEntry {
  response: NewsFeedResponse;
  timestamp: number;
}

export class LiveNewsService {
  private provider: NewsProvider;
  private cache: Map<string, CacheEntry> = new Map();
  private cacheTtlMs: number;

  constructor(provider?: NewsProvider, cacheTtlMinutes = 10) {
    this.provider = provider || new RSSNewsProvider();
    this.cacheTtlMs = cacheTtlMinutes * 60 * 1000;
  }

  public setProvider(newProvider: NewsProvider) {
    this.provider = newProvider;
    this.cache.clear();
  }

  public async getLatestNews(options: FetchNewsOptions = {}): Promise<NewsFeedResponse> {
    const cacheKey = `${options.category || 'all'}:${options.limit || 25}:${options.language || 'en'}`;
    const now = Date.now();

    const cached = this.cache.get(cacheKey);
    if (cached && now - cached.timestamp < this.cacheTtlMs) {
      return cached.response;
    }

    try {
      const freshResponse = await this.provider.fetchLatest(options);
      // Cache if articles were retrieved or if valid response
      if (freshResponse && freshResponse.articles) {
        this.cache.set(cacheKey, {
          response: freshResponse,
          timestamp: now
        });
      }
      return freshResponse;
    } catch (err: any) {
      // If we have an existing expired cache entry, return it with a warning
      if (cached) {
        return {
          ...cached.response,
          warnings: [
            ...cached.response.warnings,
            `Live feed refresh failed (${err.message || 'error'}). Serving cached news from ${new Date(
              cached.timestamp
            ).toLocaleTimeString()}.`
          ]
        };
      }

      return {
        articles: [],
        fetchedAt: new Date().toISOString(),
        provider: this.provider.name,
        categories: [],
        warnings: [`Failed to retrieve news from provider: ${err.message || 'Unknown network error'}`]
      };
    }
  }

  public clearCache(): void {
    this.cache.clear();
  }
}

export const liveNewsService = new LiveNewsService();
