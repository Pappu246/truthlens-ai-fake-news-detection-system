#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const REGISTRY = path.join(ROOT, "research", "research-intelligence-registry.json");
const OUT_DIR = process.env.RESEARCH_INTELLIGENCE_OUT || path.join(ROOT, "research-intelligence-output");
const now = new Date();
const isoNow = now.toISOString();
const lookbackDays = Number(process.env.RESEARCH_LOOKBACK_DAYS || 45);

function dateDaysAgo(days) {
  const d = new Date(Date.now() - days * 86400000);
  return d.toISOString().slice(0, 10);
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 20000);
  try {
    const res = await fetch(url, {
      ...options,
      headers: {
        "user-agent": "TruthLens-Research-Intelligence/1.0",
        "accept": "application/json",
        ...(options.headers || {})
      },
      signal: controller.signal
    });
    const text = await res.text();
    if (!res.ok) {
      return { ok: false, status: res.status, error: text.slice(0, 500), url: res.url };
    }
    try {
      return { ok: true, status: res.status, data: JSON.parse(text), url: res.url };
    } catch {
      return { ok: false, status: res.status, error: "non-json response", url: res.url };
    }
  } catch (error) {
    return {
      ok: false,
      status: null,
      error: error?.name === "AbortError" ? "timeout" : String(error),
      url
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function checkUrl(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      headers: { "user-agent": "TruthLens-Research-Intelligence/1.0" },
      signal: controller.signal
    });
    return {
      url,
      final_url: res.url,
      status: res.status,
      ok: res.ok
    };
  } catch (error) {
    return {
      url,
      final_url: null,
      status: null,
      ok: false,
      error: error?.name === "AbortError" ? "timeout" : String(error)
    };
  } finally {
    clearTimeout(timeout);
  }
}

function compactWork(work, query) {
  return {
    provider: "openalex",
    query,
    id: work.id,
    title: work.title,
    publication_date: work.publication_date,
    doi: work.doi ?? null,
    cited_by_count: work.cited_by_count ?? 0,
    landing_page_url: work.primary_location?.landing_page_url ?? null
  };
}

function compactModel(model, query) {
  return {
    provider: "huggingface",
    query,
    id: model.id,
    pipeline_tag: model.pipeline_tag ?? null,
    downloads: model.downloads ?? null,
    likes: model.likes ?? null,
    last_modified: model.lastModified ?? null
  };
}

await fs.mkdir(OUT_DIR, { recursive: true });
const registry = JSON.parse(await fs.readFile(REGISTRY, "utf8"));
const since = dateDaysAgo(lookbackDays);

const papers = [];
const paperErrors = [];
for (const item of registry.paper_search ?? []) {
  const days = Number(item.lookback_days ?? lookbackDays);
  const from = dateDaysAgo(days);
  const url = new URL("https://api.openalex.org/works");
  url.searchParams.set("search", item.query);
  url.searchParams.set("filter", "from_publication_date:" + from);
  url.searchParams.set("sort", "publication_date:desc");
  url.searchParams.set("per-page", "10");
  const result = await fetchJson(url.toString());
  if (!result.ok) {
    paperErrors.push({ provider: item.provider, query: item.query, ...result });
    continue;
  }
  for (const work of result.data?.results ?? []) papers.push(compactWork(work, item.query));
}

const paperMap = new Map();
for (const item of papers) {
  const key = item.doi || item.id || item.title;
  if (!paperMap.has(key)) paperMap.set(key, item);
}

const models = [];
const modelErrors = [];
for (const item of registry.model_search ?? []) {
  const url = new URL("https://huggingface.co/api/models");
  url.searchParams.set("search", item.query);
  url.searchParams.set("limit", "10");
  url.searchParams.set("sort", "downloads");
  url.searchParams.set("direction", "-1");
  const result = await fetchJson(url.toString());
  if (!result.ok) {
    modelErrors.push({ provider: item.provider, query: item.query, ...result });
    continue;
  }
  for (const model of result.data ?? []) models.push(compactModel(model, item.query));
}

const modelMap = new Map();
for (const item of models) {
  const key = item.id || JSON.stringify(item);
  if (!modelMap.has(key)) modelMap.set(key, item);
}

const benchmarkChecks = [];
for (const source of registry.benchmark_sources ?? []) {
  benchmarkChecks.push(await checkUrl(source.url));
}

const result = {
  schema_version: 1,
  generated_at: isoNow,
  lookback_days: lookbackDays,
  paper_window_start: since,
  discovery_only: true,
  promotion_authority: false,
  papers: [...paperMap.values()],
  paper_errors: paperErrors,
  models: [...modelMap.values()],
  model_errors: modelErrors,
  benchmark_sources: benchmarkChecks,
  policy: registry.promotion_policy,
  limitations: [
    "Discovery results are leads, not benchmark results.",
    "Paper/model popularity is not evidence of superiority.",
    "Benchmark source reachability does not validate leaderboard numbers.",
    "No production code or model is modified by this workflow.",
    "Official benchmark protocols require separate apples-to-apples evaluation."
  ]
};

await fs.writeFile(
  path.join(OUT_DIR, "research-intelligence.json"),
  JSON.stringify(result, null, 2) + "\n",
  "utf8"
);

const md = [];
md.push("# TruthLens Research Intelligence Scan");
md.push("");
md.push("Generated: " + isoNow);
md.push("Lookback window: " + lookbackDays + " days");
md.push("");
md.push("> Discovery only. This report does not establish SOTA, accuracy, or production readiness.");
md.push("");
md.push("## New paper leads");
md.push("");
md.push("| Date | Title | Cited by | Query |");
md.push("|---|---|---:|---|");
for (const p of [...paperMap.values()].sort((a,b) => (b.publication_date || "").localeCompare(a.publication_date || "")).slice(0, 40)) {
  const title = String(p.title || "Untitled").replaceAll("|", "\\|");
  md.push("|" + (p.publication_date || "") + "|" + title + "|" + (p.cited_by_count ?? 0) + "|" + p.query + "|");
}
if (paperMap.size === 0) md.push("|—|No paper results returned|—|—|");

md.push("");
md.push("## Model candidates");
md.push("");
md.push("| Model | Pipeline | Downloads | Likes | Last modified | Query |");
md.push("|---|---|---:|---:|---|---|");
for (const m of [...modelMap.values()].slice(0, 40)) {
  md.push("|" + m.id + "|" + (m.pipeline_tag || "") + "|" + (m.downloads ?? "") + "|" + (m.likes ?? "") + "|" + (m.last_modified || "") + "|" + m.query + "|");
}
if (modelMap.size === 0) md.push("|—|No model results returned|—|—|—|—|");

md.push("");
md.push("## Benchmark source health");
md.push("");
md.push("| Source | Status | Reachable | Final URL |");
md.push("|---|---:|---|---|");
for (const b of benchmarkChecks) md.push("|" + b.url + "|" + (b.status ?? "error") + "|" + (b.ok ? "yes" : "no") + "|" + (b.final_url || "") + "|");

md.push("");
md.push("## Interpretation");
md.push("");
md.push("- Candidate discovery must move to Phase 2 benchmark evaluation before any quality claim.");
md.push("- No candidate is promoted or auto-merged by this workflow.");
md.push("- Score extraction from unofficial pages is intentionally not treated as authoritative.");
md.push("- The sequential exit gates are defined in docs/V3_RESEARCH_MASTER_PLAN.md.");

await fs.writeFile(path.join(OUT_DIR, "research-intelligence.md"), md.join("\n") + "\n", "utf8");

console.log(JSON.stringify({
  generated_at: isoNow,
  papers: paperMap.size,
  models: modelMap.size,
  benchmark_sources: benchmarkChecks.length,
  output: OUT_DIR
}, null, 2));
