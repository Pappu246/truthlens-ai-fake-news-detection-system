/**
 * UI-safe presentation contract for article-model probabilities.
 *
 * A NEEDS MORE CONTEXT verdict may result from the calibrated score falling
 * inside the configured uncertainty zone; when so, both calibrated outputs
 * can still be shown as model statistics. Safety guards, incomplete inputs,
 * legacy margins, malformed values, and non-complementary pairs fail closed.
 */
export interface CalibratedProbabilityPresentationInput {
  status?: string;
  model_inference_mode?: string;
  calibration_status?: string;
  fake_probability?: number | null;
  real_probability?: number | null;
}

export interface CalibratedProbabilityPresentation {
  fakeProbability: number;
  realProbability: number;
  fakePercent: number;
  realPercent: number;
}

export function getCalibratedProbabilityPresentation(
  input: CalibratedProbabilityPresentationInput
): CalibratedProbabilityPresentation | null {
  if (input.status !== 'SUCCESS') return null;

  const exactCalibration =
    (input.model_inference_mode === 'calibrated_ensemble' &&
      input.calibration_status === 'EXACT_CALIBRATED_ENSEMBLE') ||
    (input.model_inference_mode === 'single_calibrated_svm' &&
      input.calibration_status === 'EXACT_SINGLE_CALIBRATED_SVM');
  if (!exactCalibration) return null;

  const fake = input.fake_probability;
  const real = input.real_probability;
  if (
    typeof fake !== 'number' ||
    typeof real !== 'number' ||
    !Number.isFinite(fake) ||
    !Number.isFinite(real) ||
    fake < 0 || fake > 1 ||
    real < 0 || real > 1 ||
    Math.abs(fake + real - 1) > 0.0002
  ) {
    return null;
  }

  return {
    fakeProbability: fake,
    realProbability: real,
    fakePercent: Math.round(fake * 100),
    realPercent: Math.round(real * 100)
  };
}
