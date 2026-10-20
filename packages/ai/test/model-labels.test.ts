import { REFERENCE_MODEL_LABELS } from '@unalgorithm/core';
import { describe, expect, it } from 'vitest';
import { onDeviceAvailability, onDeviceClient } from '../src/chrome-builtin/index.ts';
import { modelLabel } from '../src/index.ts';

describe('reference model labels', () => {
  it('test_reference_model_labels_match_model_label', () => {
    // core cannot import this package, so "How credits work" names the price cards' models from its own map (CL2-14).
    for (const [model, label] of Object.entries(REFERENCE_MODEL_LABELS)) expect(modelLabel(model), model).toBe(label);
  });

  it('test_built_in_model_label_names_no_browser', async () => {
    // The on-device model keeps its id (cache keys use it) in Chrome and in Edge's preview alike.
    expect(modelLabel('chrome-built-in')).toBe('Built-in AI');
    expect(modelLabel('llama3.2')).toBe('llama3.2');
    expect(await onDeviceClient().listModels()).toEqual([{ id: 'chrome-built-in', name: 'Built-in AI' }]);
    // No Prompt API here, as in Firefox.
    expect(await onDeviceAvailability()).toBe('no-api');
  });
});
