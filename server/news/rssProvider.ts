import * as cheerio from 'cheerio';
import { NewsArticle, NewsFeedResponse } from '../../src/types';
import { FetchNewsOptions, NewsFeedConfig, NewsProvider } from './types';
import { normalizeUrl } from '../security/urlValidator';

// Legitimate, high-reputation public news RSS feeds
/**
 * Minimum word count for a feed description to be treated as usable prose.
 * Mirrors the client-side threshold in src/components/InputSection.tsx so the
 * server and the UI can never disagree about what an item actually contains.
 */
export const SUBSTANTIVE_RSS_WORD_COUNT = 40;

/**
 * Labels a feed item by what the feed actually provided. A headline is never
 * presented as an article body.
 */
export function labelFeedContent(bodyText: string): {
  content_source: 'RSS_SUMMARY_ONLY' | 'HEADLINE_ONLY';
  is_headline_only: boolean;
  word_count: number;
} {
  const words = (bodyText || '').trim().split(/\s+/).filter(Boolean);
  const substantive = words.length >= SUBSTANTIVE_RSS_WORD_COUNT;
  return {
    content_source: substantive ? 'RSS_SUMMARY_ONLY' : 'HEADLINE_ONLY',
    is_headline_only: !substantive,
    word_count: words.length
  };
}

export const DEFAULT_RSS_FEEDS: NewsFeedConfig[] = [
  {
    name: 'NPR News',
    url: 'https://feeds.npr.org/1001/rss.xml',
    category: 'World'
  },
  {
    name: 'BBC News - World',
    url: 'https://feeds.bbci.co.uk/news/world/rss.xml',
    category: 'World'
  },
  {
    name: 'BBC News - Technology',
    url: 'https://feeds.bbci.co.uk/news/technology/rss.xml',
    category: 'Technology'
  },
  {
    name: 'BBC News - Business',
    url: 'https://feeds.bbci.co.uk/news/business/rss.xml',
    category: 'Business'
  },
  {
    name: 'BBC News - Science',
    url: 'https://feeds.bbci.co.uk/news/science_and_environment/rss.xml',
    category: 'Science'
  },
  {
    name: 'PBS NewsHour',
    url: 'https://www.pbs.org/newshour/feeds/rss/headlines',
    category: 'Politics'
  }
];

export class RSSNewsProvider implements NewsProvider {
  public name = 'RSSNewsProvider';
  private feeds: NewsFeedConfig[];

  constructor(customFeeds?: NewsFeedConfig[]) {
    if (customFeeds && customFeeds.length > 0) {
      this.feeds = customFeeds;
    } else if (process.env.NEWS_RSS_FEEDS) {
      this.feeds = this.parseConfiguredFeeds(process.env.NEWS_RSS_FEEDS);
    } else {
      this.feeds = DEFAULT_RSS_FEEDS;
    }
  }

  private parseConfiguredFeeds(envValue: string): NewsFeedConfig[] {
    try {
      // Allow JSON array or comma-separated URLs
      const trimmed = envValue.trim();
      if (trimmed.startsWith('[')) {
        return JSON.parse(trimmed);
      }
      return trimmed.split(',').map((u, idx) => {
        const item = u.trim();
        return {
          name: `Feed #${idx + 1}`,
          url: item,
          category: 'General'
        };
      });
    } catch {
      return DEFAULT_RSS_FEEDS;
    }
  }

  public async fetchLatest(options: FetchNewsOptions = {}): Promise<NewsFeedResponse> {
    const warnings: string[] = [];
    const limit = options.limit ?? 25;
    const categoryFilter = options.category ? options.category.toLowerCase() : null;

    if (!this.feeds || this.feeds.length === 0) {
      return {
        articles: [],
        fetchedAt: new Date().toISOString(),
        provider: this.name,
        categories: [],
        warnings: ['No live news feeds are configured.']
      };
    }

    const allArticles: NewsArticle[] = [];
    const seenUrls = new Set<string>();
    const seenTitles = new Set<string>();
    const availableCategories = new Set<string>();

    const feedPromises = this.feeds.map(async (feed) => {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 8000);

        const res = await fetch(feed.url, {
          headers: {
            'User-Agent': 'TruthLens-News-Reader/1.0 (+https://truthlens.ai)',
            Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.1'
          },
          signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!res.ok) {
          warnings.push(`Feed '${feed.name}' returned HTTP status ${res.status}`);
          return;
        }

        const xmlText = await res.text();
        const parsed = this.parseXmlFeed(xmlText, feed);
        for (const item of parsed) {
          allArticles.push(item);
          if (item.category) availableCategories.add(item.category);
        }
      } catch (err: any) {
        const msg = err.name === 'AbortError' ? 'timed out after 8s' : (err.message || 'fetch error');
        warnings.push(`Feed '${feed.name}' failed to load (${msg})`);
      }
    });

    await Promise.allSettled(feedPromises);

    // Deduplicate and filter
    const deduped: NewsArticle[] = [];
    for (const article of allArticles) {
      if (!article.url || !article.title) continue;

      const normUrl = normalizeUrl(article.url);
      const titleKey = article.title.toLowerCase().replace(/[^a-z0-9]/g, '');

      if (seenUrls.has(normUrl) || (titleKey.length > 15 && seenTitles.has(titleKey))) {
        continue;
      }

      seenUrls.add(normUrl);
      if (titleKey.length > 15) seenTitles.add(titleKey);

      // Category filter if specified
      if (categoryFilter && categoryFilter !== 'all') {
        const articleCat = (article.category || '').toLowerCase();
        if (!articleCat.includes(categoryFilter)) {
          continue;
        }
      }

      deduped.push(article);
    }

    // Sort by publication date (newest first)
    deduped.sort((a, b) => {
      const timeA = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
      const timeB = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
      return timeB - timeA;
    });

    return {
      articles: deduped.slice(0, limit),
      fetchedAt: new Date().toISOString(),
      provider: this.name,
      categories: Array.from(availableCategories),
      warnings
    };
  }

  private parseXmlFeed(xml: string, feedConfig: NewsFeedConfig): NewsArticle[] {
    const articles: NewsArticle[] = [];
    const $ = cheerio.load(xml, { xmlMode: true });

    // 1. Check RSS 2.0 items
    const rssItems = $('item');
    if (rssItems.length > 0) {
      rssItems.each((idx, el) => {
        const $el = $(el);
        const title = $el.find('title').first().text().trim();
        let rawLink = $el.find('link').first().text().trim();
        if (!rawLink) {
          rawLink = $el.find('guid').first().text().trim();
        }

        // Clean description (strip CDATA / HTML tags)
        let desc = $el.find('description').first().text().trim();
        desc = desc.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

        // Published date
        const pubDate = $el.find('pubDate').first().text().trim();
        let publishedIso: string | undefined = undefined;
        if (pubDate) {
          const parsedDate = new Date(pubDate);
          if (!isNaN(parsedDate.getTime())) {
            publishedIso = parsedDate.toISOString();
          }
        }

        // Image enclosure or media thumbnail
        let imageUrl = $el.find('enclosure[type^="image"]').attr('url') ||
          $el.find('media\\:content[medium="image"]').attr('url') ||
          $el.find('media\\:thumbnail').attr('url');

        // Category
        const itemCategory = $el.find('category').first().text().trim() || feedConfig.category || 'General';

        if (title && rawLink && (rawLink.startsWith('http://') || rawLink.startsWith('https://'))) {
          articles.push({
            id: `rss-${feedConfig.name.replace(/\s+/g, '_')}-${idx}-${Date.now()}`,
            title,
            description: desc || undefined,
            url: rawLink,
            sourceName: feedConfig.name,
            publishedAt: publishedIso,
            imageUrl: imageUrl || undefined,
            category: itemCategory,
            ...labelFeedContent(desc)
          });
        }
      });
      return articles;
    }

    // 2. Check Atom entries
    const atomEntries = $('entry');
    if (atomEntries.length > 0) {
      atomEntries.each((idx, el) => {
        const $el = $(el);
        const title = $el.find('title').first().text().trim();
        let link = $el.find('link[rel="alternate"]').attr('href') || $el.find('link').attr('href') || '';

        let desc = $el.find('summary').first().text().trim() || $el.find('content').first().text().trim();
        desc = desc.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

        const published = $el.find('published').first().text().trim() || $el.find('updated').first().text().trim();
        let publishedIso: string | undefined = undefined;
        if (published) {
          const parsedDate = new Date(published);
          if (!isNaN(parsedDate.getTime())) {
            publishedIso = parsedDate.toISOString();
          }
        }

        const itemCategory = $el.find('category').attr('term') || feedConfig.category || 'General';

        if (title && link && (link.startsWith('http://') || link.startsWith('https://'))) {
          articles.push({
            id: `atom-${feedConfig.name.replace(/\s+/g, '_')}-${idx}-${Date.now()}`,
            title,
            description: desc || undefined,
            url: link,
            sourceName: feedConfig.name,
            publishedAt: publishedIso,
            category: itemCategory,
            ...labelFeedContent(desc)
          });
        }
      });
      return articles;
    }

    return articles;
  }
}
