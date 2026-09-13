import { NewsArticle, NewsFeedResponse } from '../../src/types';

export interface FetchNewsOptions {
  category?: string;
  language?: string;
  limit?: number;
}

export interface NewsFeedConfig {
  name: string;
  url: string;
  category?: string;
}

export interface NewsProvider {
  name: string;
  fetchLatest(options?: FetchNewsOptions): Promise<NewsFeedResponse>;
  search?(query: string, options?: { limit?: number }): Promise<NewsArticle[]>;
  getArticle?(idOrUrl: string): Promise<NewsArticle | null>;
}
