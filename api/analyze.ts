import { mlEngine } from '../server/mlEngine';

export default function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ detail: 'Method not allowed' });
  }

  try {
    const body = req.body || {};
    const text = body.text || body.raw_text || '';
    const sourceUrl = body.source_url || '';
    const inputType = body.input_type || 'text';

    const result = mlEngine.analyzeArticle(text, sourceUrl, {
      inputType,
      originalUrl: body.original_url || sourceUrl,
      canonicalUrl: body.canonical_url,
      articleTitle: body.article_title,
      sourceName: body.source_name,
      author: body.author,
      publishedAt: body.published_at,
      wordCount: body.word_count,
      extractionStatus: body.extraction_status,
      warnings: body.warnings,
      isHeadlineOnly: body.is_headline_only
    });

    return res.status(200).json(result);
  } catch (error: any) {
    return res.status(400).json({ detail: error?.message || 'Analysis failed' });
  }
}
