import { REFERENCE_MODEL_LABELS } from '@unalgorithm/core';
import { describe, expect, it } from 'vitest';
import { modelLabel } from '../src/index.ts';

describe('reference model labels', () => {
  it('test_reference_model_labels_match_model_label', () => {
    // core cannot import this package, so "How credits work" names the price cards' models from its own map (CL2-14).
    for (const [model, label] of Object.entries(REFERENCE_MODEL_LABELS)) expect(modelLabel(model), model).toBe(label);
  });
});
