import fs from 'fs';
import path from 'path';

// Seeded PRNG (Mulberry32) for reproducible splits and training
function mulberry32(seed: number) {
  return function() {
    let t = seed += 0x6D2B79F5;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// English stopwords
const STOPWORDS = new Set([
  'a', 'about', 'above', 'after', 'again', 'against', 'all', 'am', 'an', 'and', 'any', 'are', "aren't",
  'as', 'at', 'be', 'because', 'been', 'before', 'being', 'below', 'between', 'both', 'but', 'by', 'can',
  'cannot', 'could', "couldn't", 'did', "didn't", 'do', 'does', "doesn't", 'doing', "don't", 'down',
  'during', 'each', 'few', 'for', 'from', 'further', 'had', "hadn't", 'has', "hasn't", 'have', "haven't",
  'having', 'he', "he'd", "he'll", "he's", 'her', 'here', "here's", 'hers', 'herself', 'him', 'himself',
  'his', 'how', "how's", 'i', "i'd", "i'll", "i'm", "i've", 'if', 'in', 'into', 'is', "isn't", 'it',
  "it's", 'its', 'itself', "let's", 'me', 'more', 'most', "mustn't", 'my', 'myself', 'no', 'nor', 'not',
  'of', 'off', 'on', 'once', 'only', 'or', 'other', 'ought', 'our', 'ours', 'ourselves', 'out', 'over', 'own',
  'same', "shan't", 'she', "she'd", "she'll", "she's", 'should', "shouldn't", 'so', 'some', 'such',
  'than', 'that', "that's", 'the', 'their', 'theirs', 'them', 'themselves', 'then', 'there', "there's",
  'these', 'they', "they'd", "they'll", "they're", "they've", 'this', 'those', 'through', 'to', 'too',
  'under', 'until', 'up', 'very', 'was', "wasn't", 'we', "we'd", "we'll", "we're", "we've", 'were',
  "weren't", 'what', "what's", 'when', "when's", 'where', "where's", 'which', 'while', 'who', "who's",
  'whom', 'why', "why's", 'with', "won't", 'would', "wouldn't", 'you', "you'd", "you'll", "you're",
  "you've", 'your', 'yours', 'yourself', 'yourselves'
]);

export function cleanText(text: string, removeStopwords = true): string {
  if (!text) return '';
  let cleaned = text.toLowerCase();
  cleaned = cleaned.replace(/https?:\/\/\S+|www\.\S+/g, ' ');
  cleaned = cleaned.replace(/<.*?>/g, ' ');
  cleaned = cleaned.replace(/[.,\/#!$%\^&\*;:{}=\-_`~()?"'\[\]]/g, ' ');
  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  if (removeStopwords) {
    const tokens = cleaned.split(' ').filter(t => !STOPWORDS.has(t) && t.length >= 3);
    cleaned = tokens.join(' ');
  }
  return cleaned;
}

export function runValidation() {
  const rng = mulberry32(42);

  // 1. Read dataset
  const datasetPath = path.join(process.cwd(), 'data', 'news.csv');
  const rawCsv = fs.readFileSync(datasetPath, 'utf-8');
  const lines = rawCsv.split('\n');
  const header = lines[0].trim();
  const samples: { id: number; title: string; text: string; combined: string; labelStr: string; label: number }[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const match = line.match(/^"([^"]*)","([^"]*)","([^"]*)"$/);
    if (match) {
      const title = match[1];
      const text = match[2];
      const labelStr = match[3];
      const label = labelStr === 'FAKE' ? 1 : 0;
      samples.push({ id: i, title, text, combined: `${title} ${text}`, labelStr, label });
    }
  }

  const realSamples = samples.filter(s => s.label === 0);
  const fakeSamples = samples.filter(s => s.label === 1);

  console.log('=== DATASET INSPECTION ===');
  console.log(`Filename: ${datasetPath}`);
  console.log(`Total samples: ${samples.length}`);
  console.log(`Header columns: ${header}`);
  console.log(`REAL samples: ${realSamples.length} (${(realSamples.length / samples.length * 100).toFixed(1)}%)`);
  console.log(`FAKE samples: ${fakeSamples.length} (${(fakeSamples.length / samples.length * 100).toFixed(1)}%)`);

  // 2. Stratified train/test split with random seed 42
  // Shuffle reals and fakes independently
  function shuffle<T>(arr: T[]): T[] {
    const copy = [...arr];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }

  const shuffledReal = shuffle(realSamples);
  const shuffledFake = shuffle(fakeSamples);

  // 80% train, 20% test: 14 train real, 4 test real; 14 train fake, 4 test fake
  const trainReal = shuffledReal.slice(0, 14);
  const testReal = shuffledReal.slice(14);
  const trainFake = shuffledFake.slice(0, 14);
  const testFake = shuffledFake.slice(14);

  const trainSet = shuffle([...trainReal, ...trainFake]);
  const testSet = shuffle([...testReal, ...testFake]);

  console.log('\n=== TRAIN / TEST SPLIT (No Data Leakage) ===');
  console.log(`Train count: ${trainSet.length} (14 REAL, 14 FAKE)`);
  console.log(`Test count: ${testSet.length} (4 REAL, 4 FAKE)`);

  // 3. Fit TF-IDF Vectorizer ONLY on trainSet
  const trainDocs = trainSet.map(s => cleanText(s.combined));
  const termDocFreq = new Map<string, number>();

  for (const doc of trainDocs) {
    const words = doc.split(' ');
    const seen = new Set<string>();
    // Unigrams
    for (const w of words) {
      if (w.length >= 3) seen.add(w);
    }
    // Bigrams
    for (let i = 0; i < words.length - 1; i++) {
      if (words[i].length >= 3 && words[i + 1].length >= 3) {
        seen.add(`${words[i]} ${words[i + 1]}`);
      }
    }
    for (const term of seen) {
      termDocFreq.set(term, (termDocFreq.get(term) || 0) + 1);
    }
  }

  const vocabulary = new Map<string, number>();
  const idf: number[] = [];
  const N_train = trainDocs.length;
  let termIdx = 0;

  for (const [term, df] of termDocFreq.entries()) {
    vocabulary.set(term, termIdx);
    const idfVal = Math.log((1 + N_train) / (1 + df)) + 1.0;
    idf.push(idfVal);
    termIdx++;
  }

  const V = vocabulary.size;
  console.log(`Fitted TF-IDF Vocabulary on train only: ${V} n-gram terms (unigrams + bigrams)`);

  // Vectorizer transform function
  function vectorize(text: string): [number, number][] {
    const cleaned = cleanText(text);
    const words = cleaned.split(' ');
    const counts = new Map<string, number>();

    for (const w of words) {
      if (w.length >= 3) counts.set(w, (counts.get(w) || 0) + 1);
    }
    for (let i = 0; i < words.length - 1; i++) {
      if (words[i].length >= 3 && words[i + 1].length >= 3) {
        const bi = `${words[i]} ${words[i + 1]}`;
        counts.set(bi, (counts.get(bi) || 0) + 1);
      }
    }

    const vec: [number, number][] = [];
    let normSq = 0;

    for (const [term, count] of counts.entries()) {
      const idx = vocabulary.get(term);
      if (idx !== undefined) {
        const tf = 1.0 + Math.log(count);
        const tfidfVal = tf * idf[idx];
        vec.push([idx, tfidfVal]);
        normSq += tfidfVal * tfidfVal;
      }
    }

    const norm = Math.sqrt(normSq) || 1.0;
    return vec.map(([idx, val]) => [idx, val / norm]);
  }

  const X_train = trainSet.map(s => vectorize(s.combined));
  const y_train = trainSet.map(s => s.label);
  const X_test = testSet.map(s => vectorize(s.combined));
  const y_test = testSet.map(s => s.label);

  // 4. Train Model 1: Logistic Regression (Cross-Entropy with L2 penalty)
  const lrWeights = new Array(V).fill(0);
  let lrBias = 0;
  const lrEpochs = 100;
  const lrRate = 0.15;
  const lrLambda = 0.001;

  for (let epoch = 0; epoch < lrEpochs; epoch++) {
    for (let i = 0; i < X_train.length; i++) {
      const x = X_train[i];
      const y = y_train[i];
      let z = lrBias;
      for (const [idx, val] of x) z += lrWeights[idx] * val;
      const p = 1.0 / (1.0 + Math.exp(-z));
      const err = p - y;

      for (const [idx, val] of x) {
        lrWeights[idx] = lrWeights[idx] * (1 - lrRate * lrLambda) - lrRate * err * val;
      }
      lrBias -= lrRate * err;
    }
  }

  // 5. Train Model 2: Linear SVM (Hinge loss with L2 penalty) + Platt Sigmoid Calibration
  const svmWeights = new Array(V).fill(0);
  let svmBias = 0;
  const svmEpochs = 80;
  const svmRate = 0.08;
  const svmLambda = 0.001;

  for (let epoch = 0; epoch < svmEpochs; epoch++) {
    for (let i = 0; i < X_train.length; i++) {
      const x = X_train[i];
      const y = y_train[i] === 1 ? 1 : -1;
      let z = svmBias;
      for (const [idx, val] of x) z += svmWeights[idx] * val;
      const margin = y * z;

      if (margin < 1) {
        for (const [idx, val] of x) {
          svmWeights[idx] = svmWeights[idx] * (1 - svmRate * svmLambda) + svmRate * y * val;
        }
        svmBias += svmRate * y;
      } else {
        for (const [idx] of x) {
          svmWeights[idx] = svmWeights[idx] * (1 - svmRate * svmLambda);
        }
      }
    }
  }

  // Fit Platt Sigmoid Calibration on training decision margins:
  // P(y=1) = 1 / (1 + exp(A * z + B))
  const trainMargins = X_train.map((x, i) => {
    let z = svmBias;
    for (const [idx, val] of x) z += svmWeights[idx] * val;
    return { z, y: y_train[i] };
  });

  let plattA = -2.0;
  let plattB = 0.0;
  for (let iter = 0; iter < 50; iter++) {
    let gradA = 0;
    let gradB = 0;
    for (const m of trainMargins) {
      const p = 1.0 / (1.0 + Math.exp(plattA * m.z + plattB));
      const diff = p - m.y;
      gradA += diff * m.z;
      gradB += diff;
    }
    plattA -= 0.02 * (gradA / trainMargins.length);
    plattB -= 0.02 * (gradB / trainMargins.length);
  }

  console.log(`Platt Sigmoid Calibration fitted: A = ${plattA.toFixed(4)}, B = ${plattB.toFixed(4)}`);

  // 6. Evaluation function
  function evaluate(preds: number[], probs: number[], yTrue: number[]) {
    let tp = 0, fp = 0, fn = 0, tn = 0;
    for (let i = 0; i < yTrue.length; i++) {
      if (preds[i] === 1 && yTrue[i] === 1) tp++;
      else if (preds[i] === 1 && yTrue[i] === 0) fp++;
      else if (preds[i] === 0 && yTrue[i] === 1) fn++;
      else tn++;
    }
    const acc = (tp + tn) / yTrue.length;
    const prec = (tp + fp) > 0 ? tp / (tp + fp) : 0;
    const rec = (tp + fn) > 0 ? tp / (tp + fn) : 0;
    const f1 = (prec + rec) > 0 ? (2 * prec * rec) / (prec + rec) : 0;
    return {
      accuracy: Math.round(acc * 1000) / 1000,
      precision: Math.round(prec * 1000) / 1000,
      recall: Math.round(rec * 1000) / 1000,
      f1_score: Math.round(f1 * 1000) / 1000,
      confusion_matrix: {
        matrix: [[tn, fp], [fn, tp]],
        true_negative: tn,
        false_positive: fp,
        false_negative: fn,
        true_positive: tp,
        labels: ['REAL (0)', 'FAKE (1)']
      }
    };
  }

  // Logistic Regression test predictions
  const lrTestProbs = X_test.map(x => {
    let z = lrBias;
    for (const [idx, val] of x) z += lrWeights[idx] * val;
    return 1.0 / (1.0 + Math.exp(-z));
  });
  const lrTestPreds = lrTestProbs.map(p => p >= 0.5 ? 1 : 0);
  const lrMetrics = evaluate(lrTestPreds, lrTestProbs, y_test);

  // Linear SVM calibrated test predictions
  const svmTestMargins = X_test.map(x => {
    let z = svmBias;
    for (const [idx, val] of x) z += svmWeights[idx] * val;
    return z;
  });
  const svmTestProbs = svmTestMargins.map(z => 1.0 / (1.0 + Math.exp(plattA * z + plattB)));
  const svmTestPreds = svmTestProbs.map(p => p >= 0.5 ? 1 : 0);
  const svmMetrics = evaluate(svmTestPreds, svmTestProbs, y_test);

  console.log('\n=== MODEL EVALUATION METRICS (TEST SET) ===');
  console.log('1. Logistic Regression:');
  console.log(`   Accuracy: ${lrMetrics.accuracy}`);
  console.log(`   Precision: ${lrMetrics.precision}`);
  console.log(`   Recall: ${lrMetrics.recall}`);
  console.log(`   F1-score: ${lrMetrics.f1_score}`);
  console.log('   Confusion Matrix:');
  console.log(`     [TN=${lrMetrics.confusion_matrix.true_negative}, FP=${lrMetrics.confusion_matrix.false_positive}]`);
  console.log(`     [FN=${lrMetrics.confusion_matrix.false_negative}, TP=${lrMetrics.confusion_matrix.true_positive}]`);

  console.log('\n2. Linear SVM (Calibrated):');
  console.log(`   Accuracy: ${svmMetrics.accuracy}`);
  console.log(`   Precision: ${svmMetrics.precision}`);
  console.log(`   Recall: ${svmMetrics.recall}`);
  console.log(`   F1-score: ${svmMetrics.f1_score}`);
  console.log('   Confusion Matrix:');
  console.log(`     [TN=${svmMetrics.confusion_matrix.true_negative}, FP=${svmMetrics.confusion_matrix.false_positive}]`);
  console.log(`     [FN=${svmMetrics.confusion_matrix.false_negative}, TP=${svmMetrics.confusion_matrix.true_positive}]`);

  // Model Selection
  let bestModelName = 'Linear SVM (Calibrated)';
  let selectedWeights = svmWeights;
  let selectedBias = svmBias;
  let bestMetrics = svmMetrics;
  let selectionReason = '';

  if (svmMetrics.f1_score > lrMetrics.f1_score) {
    bestModelName = 'Linear SVM (Calibrated)';
    selectedWeights = svmWeights;
    selectedBias = svmBias;
    bestMetrics = svmMetrics;
    selectionReason = `Linear SVM achieved higher F1-score (${svmMetrics.f1_score} vs ${lrMetrics.f1_score}).`;
  } else if (lrMetrics.f1_score > svmMetrics.f1_score) {
    bestModelName = 'Logistic Regression';
    selectedWeights = lrWeights;
    selectedBias = lrBias;
    bestMetrics = lrMetrics;
    selectionReason = `Logistic Regression achieved higher F1-score (${lrMetrics.f1_score} vs ${svmMetrics.f1_score}).`;
  } else {
    // Both tied on F1-score -> check accuracy or margin property
    bestModelName = 'Linear SVM (Calibrated)';
    selectedWeights = svmWeights;
    selectedBias = svmBias;
    bestMetrics = svmMetrics;
    selectionReason = 'Tied on F1-score; Linear SVM selected for maximum-margin generalization and Platt sigmoid calibration.';
  }

  console.log(`\n=== MODEL SELECTION ===`);
  console.log(`Selected Model: ${bestModelName}`);
  console.log(`Reason: ${selectionReason}`);

  // 7. Test cases (10 diverse articles)
  const testArticles = [
    {
      id: "TEST-01",
      name: "NASA James Webb Infrared Star Nursery",
      text: "Astronomers utilizing the James Webb Space Telescope have captured unprecedented infrared observations of star-forming regions in the nearby NGC 346 cluster. According to peer-reviewed findings published this week in the Astrophysical Journal, the spectroscopic data confirms molecular hydrogen density variations consistent with theoretical models of stellar nurseries. Dr. Elena Vance, lead astrophysicist at the Goddard Space Flight Center, stated that the observations provide critical calibration measurements for understanding galactic evolution during the cosmic noon epoch. Further telemetry and calibration data have been archived at the Space Telescope Science Institute for open academic inquiry."
    },
    {
      id: "TEST-02",
      name: "Alien Mothership Moon Conspiratorial Alert",
      text: "ANONYMOUS PENTAGON OFFICIALS HAVE LEAKED SHOCKING CLASSIFIED FOOTAGE! A massive alien mothership over five miles wide is hovering in lunar orbit completely concealed from civilian telescopes using cloaking technology! The mainstream media and shadow government are desperately attempting to scrub this unbelievable truth from the internet! Insiders confirm that world leaders signed a secret treaty allowing deep-state extraction operations in exchange for zero-point energy weapons! Share this before the global elites delete it forever! You will never look at the night sky the same way again!"
    },
    {
      id: "TEST-03",
      name: "Federal Reserve Monetary Policy Rate Decision",
      text: "The Federal Reserve announced on Wednesday that its Federal Open Market Committee decided to maintain the benchmark federal funds rate in a target range of 5.25% to 5.50%. In an official statement following the two-day monetary policy meeting, officials noted that economic activity continued to expand at a solid pace, with job gains remaining strong and inflation easing over the past year while remaining somewhat elevated. Fed Chair Jerome Powell reiterated during the subsequent press briefing that central bankers will evaluate incoming macroeconomic data, evolving financial conditions, and labor market resilience before considering any future adjustments to monetary easing."
    },
    {
      id: "TEST-04",
      name: "Miracle Himalayan Diabetes Root Cure",
      text: "Big Pharma is furious because a retired doctor discovered an ancient Himalayan root that obliterates high blood sugar and reverses type 2 diabetes overnight! Corrupt medical institutions and pharmaceutical billionaires have spent millions silencing this natural remedy to protect their insulin monopoly profits! Thousands of patients have thrown away their medication after drinking this sacred tea for two days! Do not let doctors keep you enslaved to toxic prescription pills! Watch the censored video now before federal agents raid the herbalist warehouse!"
    },
    {
      id: "TEST-05",
      name: "Unconfirmed Quantum Processor Supply Chain Rumor",
      text: "Insiders claim that a groundbreaking quantum computing processor may launch ahead of schedule next month, according to unconfirmed supply chain rumors circulating in Asian markets. Early reports suggest performance improvements of up to 400 percent over existing silicon architectures, though independent benchmarks have not yet been made public. Company representatives declined to comment on future product roadmaps or verify specifications."
    },
    {
      id: "TEST-06",
      name: "CISA Critical VPN Advisory and Directive",
      text: "The Cybersecurity and Infrastructure Security Agency (CISA) issued an urgent operational directive on Tuesday urging enterprise administrators to patch a critical remote code execution vulnerability impacting enterprise VPN appliances. The vulnerability, tracked under CVE-2024-21887, carries a CVSS severity rating of 9.8 and allows unauthenticated threat actors to execute arbitrary commands over network interfaces. Technical remediation guidelines and network indicators of compromise have been made publicly accessible via the National Vulnerability Database."
    },
    {
      id: "TEST-07",
      name: "5G Tower Infrasound Mind Control Warning",
      text: "URGENT WARNING: Declassified electromagnetic documents confirm that newly installed 5G utility poles are secretly emitting sub-audible infrasound frequencies designed to induce compliance and lethargy in surrounding residential populations! Telecommunications executives were caught on hidden camera admitting that the wireless cellular upgrade had nothing to do with internet download speeds! Protect your home with specialized aluminum shielding fabric before the final frequency sweep begins this weekend!"
    },
    {
      id: "TEST-08",
      name: "MIT Biodegradable Biopolymer from Sugarcane",
      text: "Chemical engineers at the Massachusetts Institute of Technology have engineered a novel biopolymer synthesized from cellulose derived from agricultural sugarcane remnants. Laboratory testing published in Nature Materials demonstrates that the composite material exhibits tensile strength and thermal stability comparable to conventional polyethylene terephthalate (PET), while achieving 98 percent biodegradation in standard composting conditions within 180 days without leaving microplastic residues."
    },
    {
      id: "TEST-09",
      name: "Boiling Lemon Water Overnight Fat Melting Trick",
      text: "Celebrity fitness trainers are stunned by this weird pantry trick that melts away stubborn abdominal fat while you sleep! No exercise, no diet, and no effort required—just squeeze three lemons into boiling distilled water and watch your metabolism multiply by 800 percent! Top cardiologists tried to ban this Japanese military secret because weight loss supplement companies are losing billions of dollars! Read the full secret recipe before it is taken down by corporate censors!"
    },
    {
      id: "TEST-10",
      name: "Wall Street Moderation and S&P 500 Gains",
      text: "Major equity indices recorded modest gains during Thursday trading on Wall Street as consumer price index figures came in slightly below consensus forecasts. The S&P 500 advanced 0.6 percent to close at 5,062 points, while the tech-heavy Nasdaq Composite rose 0.8 percent. Market strategists noted that moderation in energy and core services expenditures provided reassurance to investors concerned about sustained interest rate pressures. Trading volumes remained in line with historical moving averages."
    }
  ];

  console.log('\n=== DYNAMIC INFERENCE TESTS (10 DIVERSE CASES) ===');
  const results = [];
  const fake_threshold = 0.65;
  const real_threshold = 0.35;

  for (const article of testArticles) {
    const vec = vectorize(article.text);
    let z = selectedBias;
    for (const [idx, val] of vec) z += selectedWeights[idx] * val;
    const fakeProbRaw = 1.0 / (1.0 + Math.exp(plattA * z + plattB));
    const fakeProb = Math.round(fakeProbRaw * 10000) / 10000;
    const realProb = Math.round((1.0 - fakeProb) * 10000) / 10000;

    let prediction: string;
    let confidence: number;

    if (fakeProb >= fake_threshold) {
      prediction = 'LIKELY FAKE';
      confidence = fakeProb;
    } else if (fakeProb <= real_threshold) {
      prediction = 'LIKELY REAL';
      confidence = realProb;
    } else {
      prediction = 'SUSPICIOUS';
      confidence = Math.max(fakeProb, realProb);
    }

    results.push({
      text_id: article.id,
      name: article.name,
      prediction,
      fake_probability: fakeProb,
      real_probability: realProb,
      confidence,
      model: bestModelName
    });

    console.log(`ID: ${article.id} | ${prediction.padEnd(11)} | Fake: ${fakeProb.toFixed(4)} | Real: ${realProb.toFixed(4)} | Conf: ${(confidence * 100).toFixed(1)}% | Model: ${bestModelName}`);
  }

  return {
    lrMetrics,
    svmMetrics,
    bestModelName,
    testCount: results.length
  };
}

runValidation();
