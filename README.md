# TruthLens AI

**AI-powered fake-news detection and claim verification system.**

TruthLens AI combines machine-learning predictions with claim extraction, evidence analysis, source evaluation, and a web interface for reviewing news credibility.

## Run Locally

### Prerequisites

- Node.js
- Python 3
- A configured Gemini API key if using Gemini-powered features

### Installation

```bash
npm install
python -m pip install -r requirements.txt
```

### Environment

Create a local environment file and add your API key:

```bash
GEMINI_API_KEY=your_gemini_api_key
```

### Start the app

```bash
npm run dev
```

## Project Structure

- `src/` — frontend application and UI components
- `server/` — server-side services, ML engine, verification, security, and history
- `backend/` — Python ML pipeline, models, and verification utilities
- `data/` — datasets and validation data
- `scripts/` — training, evaluation, and acceptance-test scripts

## Important

Model predictions are decision-support signals, not absolute proof that a claim is true or false. Always review the available evidence and source context.
