// Copyright 2026 DeepL SE (https://www.deepl.com)
// Use of this source code is governed by an MIT
// license that can be found in the LICENSE file.
//
// Tests for POST /v2/write/correct
//
// Run against mock:  DEEPL_SERVER_URL=http://localhost:3000 DEEPL_AUTH_KEY=test:fx npm test
// Run against live:  DEEPL_SERVER_URL=https://api.deepl.com DEEPL_AUTH_KEY=<key> npm test
//
// Assertions are kept to what the spec declares, so the same file can be pointed at production to
// check the mock and the real API still agree. Nothing here asserts the mock's canned text.

const { post } = require('./helpers');

describe('POST /v2/write/correct', () => {
  it('returns 200 with one improvement per input text', async () => {
    const { status, data } = await post('/v2/write/correct', {
      text: ['this is a example sentence to imprve'],
      target_lang: 'en-US',
    });
    expect(status).toBe(200);
    expect(Array.isArray(data.improvements)).toBe(true);
    expect(data.improvements).toHaveLength(1);
  });

  it('describes each improvement with text, detected_source_language and target_language', async () => {
    const { data } = await post('/v2/write/correct', {
      text: ['this is a example sentence to imprve'],
      target_lang: 'en-US',
    });
    const [improvement] = data.improvements;
    expect(typeof improvement.text).toBe('string');
    expect(typeof improvement.detected_source_language).toBe('string');
    expect(typeof improvement.target_language).toBe('string');
  });

  it('preserves the order and count of a multi-text request', async () => {
    const { status, data } = await post('/v2/write/correct', {
      text: ['first sentnce', 'second sentnce', 'third sentnce'],
      target_lang: 'en-US',
    });
    expect(status).toBe(200);
    expect(data.improvements).toHaveLength(3);
  });

  // target_lang is optional in the spec: correct detects and corrects in the source language.
  it('accepts a request with no target_lang', async () => {
    const { status, data } = await post('/v2/write/correct', {
      text: ['this is a example sentence to imprve'],
    });
    expect(status).toBe(200);
    expect(data.improvements).toHaveLength(1);
  });

  it('rejects a request with no text', async () => {
    const { status } = await post('/v2/write/correct', { target_lang: 'en-US' });
    expect(status).toBe(400);
  });

  it('rejects a target language the write product does not support', async () => {
    const { status } = await post('/v2/write/correct', {
      text: ['this is a example sentence to imprve'],
      target_lang: 'xx',
    });
    expect(status).toBe(400);
  });

  // The endpoint that already existed. Correct is not allowed to have quietly broken it, and the
  // two must stay distinguishable by path even though the spec gives them the same response shape.
  it('leaves /v2/write/rephrase working', async () => {
    const { status, data } = await post('/v2/write/rephrase', {
      text: ['this is a example sentence to imprve'],
      target_lang: 'en-US',
    });
    expect(status).toBe(200);
    expect(data.improvements).toHaveLength(1);
  });
});
