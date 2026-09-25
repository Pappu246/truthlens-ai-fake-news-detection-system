import fs from 'fs';
import path from 'path';
import initSqlJs, { Database, SqlJsStatic } from 'sql.js';

/** Read a possibly-null numeric column without coercing NULL to 0. */
function toNullableNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export interface SqliteHistoryRecord {
  id: number;
  text_preview: string;
  full_text: string;
  source_url: string;
  prediction: string;
  confidence: number | null;
  confidence_score: number | null;
  fake_probability: number | null;
  real_probability: number | null;
  risk_level: string;
  model_name: string;
  detected_claim?: string;
  input_type?: string;
  original_url?: string;
  canonical_url?: string;
  article_title?: string;
  source_name?: string;
  published_at?: string;
  indicators_json: string;
  explanation_json: string;
  timestamp: string;
  indicators?: any[];
  explanation?: any[];
}

export class SqliteHistoryManager {
  private db: Database | null = null;
  private SQL: SqlJsStatic | null = null;
  private dbPath: string;
  private isReady = false;
  private initPromise: Promise<void> | null = null;
  private pendingInserts: Array<{
    full_text: string;
    prediction: string;
    confidence: number | null;
    fake_probability: number | null;
    real_probability: number | null;
    risk_level: string;
    model_name: string;
    source_url?: string;
    detected_claim?: string;
    input_type?: string;
    original_url?: string;
    canonical_url?: string;
    article_title?: string;
    source_name?: string;
    published_at?: string;
    indicators?: any[];
    explanation?: any[];
  }> = [];

  constructor() {
    // Vercel serverless filesystem is read-only except /tmp. Use /tmp there so
    // history works per-instance; Render/local keep the persistent disk path.
    this.dbPath = process.env.VERCEL === '1'
      ? path.join('/tmp', 'truthlens.db')
      : path.join(process.cwd(), 'backend', 'database', 'truthlens.db');
  }

  public async init(): Promise<void> {
    if (this.isReady && this.db) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      try {
        // Resolve the sql.js WASM binary defensively: prefer the node_modules copy
        // (present locally and via vercel.json includeFiles), otherwise fall back
        // to sql.js's own default resolution (colocated with its dist files).
        const wasmDir = path.join(process.cwd(), 'node_modules', 'sql.js', 'dist');
        const wasmFile = path.join(wasmDir, 'sql-wasm.wasm');
        this.SQL = fs.existsSync(wasmFile)
          ? await initSqlJs({ locateFile: (file: string) => path.join(wasmDir, file) })
          : await initSqlJs();

        const dir = path.dirname(this.dbPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        if (fs.existsSync(this.dbPath)) {
          const fileBuffer = fs.readFileSync(this.dbPath);
          this.db = new this.SQL.Database(fileBuffer);
        } else {
          this.db = new this.SQL.Database();
        }

        this.db.run(`
          CREATE TABLE IF NOT EXISTS history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            text_preview TEXT NOT NULL,
            full_text TEXT NOT NULL,
            source_url TEXT,
            prediction TEXT NOT NULL,
            confidence REAL,
            fake_probability REAL,
            real_probability REAL,
            risk_level TEXT NOT NULL,
            model_name TEXT NOT NULL,
            detected_claim TEXT,
            input_type TEXT DEFAULT 'text',
            original_url TEXT,
            canonical_url TEXT,
            article_title TEXT,
            source_name TEXT,
            published_at TEXT,
            indicators_json TEXT,
            explanation_json TEXT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
          );

          CREATE TABLE IF NOT EXISTS verifications (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            analysis_id TEXT,
            title TEXT,
            content_preview TEXT,
            claims_json TEXT,
            summary_json TEXT,
            final_assessment TEXT,
            final_reasoning TEXT,
            ml_risk TEXT,
            ml_synthesis TEXT,
            warnings_json TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
          );
        `);

        // Migration safety: Ensure new Phase 3 columns exist if DB was pre-created
        const migrationColumns = [
          'detected_claim TEXT',
          "input_type TEXT DEFAULT 'text'",
          'original_url TEXT',
          'canonical_url TEXT',
          'article_title TEXT',
          'source_name TEXT',
          'published_at TEXT'
        ];

        for (const col of migrationColumns) {
          try {
            this.db.run(`ALTER TABLE history ADD COLUMN ${col};`);
          } catch {
            // Column already exists
          }
        }

        // Migration: older databases declared confidence/probability columns
        // as NOT NULL. Rebuild the table once so guarded results can store
        // NULL (meaning "not available / N/A") without crashing.
        try {
          const pragma = this.db.exec('PRAGMA table_info(history)');
          const cols: Array<{ name: string; notnull: number }> = (pragma[0]?.values || []).map((v: any[]) => ({ name: String(v[1]), notnull: Number(v[3]) || 0 }));
          const hasNotNullScore = cols.some(c => ['confidence', 'fake_probability', 'real_probability'].includes(c.name) && c.notnull === 1);
          if (hasNotNullScore) {
            this.db.run(`
              CREATE TABLE history_migrated (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                text_preview TEXT NOT NULL,
                full_text TEXT NOT NULL,
                source_url TEXT,
                prediction TEXT NOT NULL,
                confidence REAL,
                fake_probability REAL,
                real_probability REAL,
                risk_level TEXT NOT NULL,
                model_name TEXT NOT NULL,
                detected_claim TEXT,
                input_type TEXT DEFAULT 'text',
                original_url TEXT,
                canonical_url TEXT,
                article_title TEXT,
                source_name TEXT,
                published_at TEXT,
                indicators_json TEXT,
                explanation_json TEXT,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
              );
              INSERT INTO history_migrated (
                id, text_preview, full_text, source_url, prediction, confidence,
                fake_probability, real_probability, risk_level, model_name,
                detected_claim, input_type, original_url, canonical_url,
                article_title, source_name, published_at, indicators_json,
                explanation_json, timestamp
              )
              SELECT
                id, text_preview, full_text, source_url, prediction, confidence,
                fake_probability, real_probability, risk_level, model_name,
                detected_claim, input_type, original_url, canonical_url,
                article_title, source_name, published_at, indicators_json,
                explanation_json, timestamp
              FROM history;
              DROP TABLE history;
              ALTER TABLE history_migrated RENAME TO history;
            `);
            console.log('[SqliteHistoryManager] Migrated history table to nullable score columns');
          }
        } catch (mErr) {
          console.error('[SqliteHistoryManager] Nullable column migration failed:', mErr);
        }

        this.isReady = true;

        // Flush any pending inserts that occurred before DB ready
        if (this.pendingInserts.length > 0) {
          for (const item of this.pendingInserts) {
            this.insertHistory(item);
          }
          this.pendingInserts = [];
        }

        this.saveToDisk();
        console.log(`[SqliteHistoryManager] SQLite DB initialized at ${this.dbPath}`);
      } catch (err) {
        console.error('[SqliteHistoryManager] Failed to initialize SQLite database:', err);
      }
    })();

    return this.initPromise;
  }

  private saveToDisk(): void {
    if (!this.db) return;
    try {
      const data = this.db.export();
      const buffer = Buffer.from(data);
      fs.writeFileSync(this.dbPath, buffer);
    } catch (err) {
      console.error('[SqliteHistoryManager] Failed to export DB to disk:', err);
    }
  }

  public insertHistory(record: {
    full_text: string;
    prediction: string;
    confidence: number | null;
    fake_probability: number | null;
    real_probability: number | null;
    risk_level: string;
    model_name: string;
    source_url?: string;
    detected_claim?: string;
    input_type?: string;
    original_url?: string;
    canonical_url?: string;
    article_title?: string;
    source_name?: string;
    published_at?: string;
    indicators?: any[];
    explanation?: any[];
  }): number {
    if (!this.db) {
      this.pendingInserts.push(record);
      return Date.now();
    }

    const textTrimmed = (record.full_text || '').trim();
    const textPreview = textTrimmed.length > 140 ? textTrimmed.substring(0, 137) + '...' : textTrimmed;
    const now = new Date().toISOString();

    const stmt = this.db.prepare(`
      INSERT INTO history (
        text_preview, full_text, source_url, prediction, confidence,
        fake_probability, real_probability, risk_level, model_name,
        detected_claim, input_type, original_url, canonical_url,
        article_title, source_name, published_at, indicators_json,
        explanation_json, timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run([
      textPreview,
      textTrimmed,
      record.source_url || '',
      record.prediction,
      record.confidence,
      record.fake_probability,
      record.real_probability,
      record.risk_level,
      record.model_name,
      record.detected_claim || '',
      record.input_type || 'text',
      record.original_url || '',
      record.canonical_url || '',
      record.article_title || '',
      record.source_name || '',
      record.published_at || '',
      JSON.stringify(record.indicators || []),
      JSON.stringify(record.explanation || []),
      now
    ]);
    stmt.free();

    // Get last insert rowid
    const res = this.db.exec("SELECT last_insert_rowid() AS id");
    const lastId = res[0] && res[0].values[0] ? (res[0].values[0][0] as number) : Date.now();

    this.saveToDisk();
    return lastId;
  }

  public getAllHistory(limit = 50): SqliteHistoryRecord[] {
    if (!this.db) return [];

    const stmt = this.db.prepare(`
      SELECT id, text_preview, full_text, source_url, prediction, confidence,
             fake_probability, real_probability, risk_level, model_name,
             detected_claim, input_type, original_url, canonical_url,
             article_title, source_name, published_at,
             indicators_json, explanation_json, timestamp
      FROM history
      ORDER BY id DESC
      LIMIT ?
    `);
    stmt.bind([limit]);

    const results: SqliteHistoryRecord[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject() as any;
      let indicators: any[] = [];
      let explanation: any[] = [];
      try { indicators = JSON.parse(row.indicators_json || '[]'); } catch {}
      try { explanation = JSON.parse(row.explanation_json || '[]'); } catch {}

      results.push({
        id: Number(row.id),
        text_preview: String(row.text_preview || ''),
        full_text: String(row.full_text || ''),
        source_url: String(row.source_url || ''),
        prediction: String(row.prediction || ''),
        confidence: toNullableNumber(row.confidence),
        confidence_score: row.confidence === null || row.confidence === undefined
          ? null
          : Math.round(Number(row.confidence) * 100),
        fake_probability: toNullableNumber(row.fake_probability),
        real_probability: toNullableNumber(row.real_probability),
        risk_level: String(row.risk_level || 'LOW'),
        model_name: String(row.model_name || 'Linear SVM (Calibrated)'),
        detected_claim: row.detected_claim || undefined,
        input_type: row.input_type || 'text',
        original_url: row.original_url || undefined,
        canonical_url: row.canonical_url || undefined,
        article_title: row.article_title || undefined,
        source_name: row.source_name || undefined,
        published_at: row.published_at || undefined,
        indicators_json: String(row.indicators_json || '[]'),
        explanation_json: String(row.explanation_json || '[]'),
        timestamp: String(row.timestamp || new Date().toISOString()),
        indicators,
        explanation
      });
    }
    stmt.free();
    return results;
  }

  public getHistoryById(id: number): SqliteHistoryRecord | undefined {
    if (!this.db) return undefined;

    const stmt = this.db.prepare(`SELECT * FROM history WHERE id = ?`);
    stmt.bind([id]);

    if (stmt.step()) {
      const row = stmt.getAsObject() as any;
      stmt.free();

      let indicators: any[] = [];
      let explanation: any[] = [];
      try { indicators = JSON.parse(row.indicators_json || '[]'); } catch {}
      try { explanation = JSON.parse(row.explanation_json || '[]'); } catch {}

      return {
        id: Number(row.id),
        text_preview: String(row.text_preview || ''),
        full_text: String(row.full_text || ''),
        source_url: String(row.source_url || ''),
        prediction: String(row.prediction || ''),
        confidence: toNullableNumber(row.confidence),
        confidence_score: row.confidence === null || row.confidence === undefined
          ? null
          : Math.round(Number(row.confidence) * 100),
        fake_probability: toNullableNumber(row.fake_probability),
        real_probability: toNullableNumber(row.real_probability),
        risk_level: String(row.risk_level || 'LOW'),
        model_name: String(row.model_name || 'Linear SVM (Calibrated)'),
        detected_claim: row.detected_claim || undefined,
        input_type: row.input_type || 'text',
        original_url: row.original_url || undefined,
        canonical_url: row.canonical_url || undefined,
        article_title: row.article_title || undefined,
        source_name: row.source_name || undefined,
        published_at: row.published_at || undefined,
        indicators_json: String(row.indicators_json || '[]'),
        explanation_json: String(row.explanation_json || '[]'),
        timestamp: String(row.timestamp || new Date().toISOString()),
        indicators,
        explanation
      };
    }
    stmt.free();
    return undefined;
  }

  public deleteHistoryItem(id: number): boolean {
    if (!this.db) return false;
    this.db.run(`DELETE FROM history WHERE id = ?`, [id]);
    this.saveToDisk();
    return true;
  }

  public clearAllHistory(): number {
    if (!this.db) return 0;
    const countRes = this.db.exec("SELECT COUNT(*) FROM history");
    const count = countRes[0] && countRes[0].values[0] ? (countRes[0].values[0][0] as number) : 0;
    this.db.run(`DELETE FROM history`);
    this.saveToDisk();
    return count;
  }

  public insertVerification(data: {
    analysis_id?: string;
    title?: string;
    article_title?: string;
    content_preview?: string;
    claims: any[];
    summary: any;
    final_assessment: string;
    final_reasoning: string;
    ml_risk: string;
    ml_synthesis: string;
    warnings: string[];
  }): number {
    if (!this.db) return Date.now();
    try {
      const stmt = this.db.prepare(`
        INSERT INTO verifications (
          analysis_id, title, content_preview, claims_json, summary_json,
          final_assessment, final_reasoning, ml_risk, ml_synthesis, warnings_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run([
        data.analysis_id || null,
        data.title || data.article_title || null,
        data.content_preview || '',
        JSON.stringify(data.claims || []),
        JSON.stringify(data.summary || {}),
        data.final_assessment || 'INSUFFICIENT EVIDENCE',
        data.final_reasoning || '',
        data.ml_risk || 'UNKNOWN',
        data.ml_synthesis || '',
        JSON.stringify(data.warnings || [])
      ]);
      stmt.free();

      const idRes = this.db.exec("SELECT last_insert_rowid()");
      const insertedId = (idRes[0] && idRes[0].values[0] && idRes[0].values[0][0]) ? Number(idRes[0].values[0][0]) : Date.now();
      this.saveToDisk();
      return insertedId;
    } catch (err) {
      console.error('[SqliteHistoryManager] Failed to insert verification record:', err);
      return Date.now();
    }
  }

  public getVerificationById(id: string | number): any | undefined {
    if (!this.db) return undefined;
    try {
      const stmt = this.db.prepare(`SELECT * FROM verifications WHERE id = ? OR analysis_id = ?`);
      stmt.bind([String(id), String(id)]);

      if (stmt.step()) {
        const row = stmt.getAsObject() as any;
        stmt.free();

        let claims = [];
        let summary = { totalClaims: 0, verifiedClaims: 0, supported: 0, contradicted: 0, mixed: 0, insufficient: 0 };
        let warnings = [];

        try { claims = JSON.parse(row.claims_json || '[]'); } catch {}
        try { summary = JSON.parse(row.summary_json || '{}'); } catch {}
        try { warnings = JSON.parse(row.warnings_json || '[]'); } catch {}

        return {
          id: String(row.id),
          analysisId: row.analysis_id,
          article: {
            title: row.title || undefined,
            contentPreview: row.content_preview || '',
            wordCount: (row.content_preview || '').split(/\s+/).length
          },
          claims,
          summary,
          finalAssessment: row.final_assessment,
          finalAssessmentReasoning: row.final_reasoning,
          mlRisk: row.ml_risk,
          mlEvidenceSynthesis: row.ml_synthesis,
          warnings,
          createdAt: row.created_at
        };
      }
      stmt.free();
      return undefined;
    } catch (err) {
      console.error('[SqliteHistoryManager] Error getting verification by ID:', err);
      return undefined;
    }
  }
}

export const sqliteHistory = new SqliteHistoryManager();
