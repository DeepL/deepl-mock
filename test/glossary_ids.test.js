// Copyright 2026 DeepL SE (https://www.deepl.com)
// Use of this source code is governed by an MIT
// license that can be found in the LICENSE file.
//
// Tests for combining glossaries with the glossary_ids parameter.
//
// Regression cover: the combined wrapper called each glossary's translate with the input only, so
// a v3 glossary never received the languages it selects its dictionary from and every request
// naming more than one glossary failed with "Glossary dictionary not found".

const { post } = require('./helpers');

async function createGlossary(name, sourceLang, targetLang, entries) {
  const { data } = await post('/v3/glossaries', {
    name,
    dictionaries: [{
      source_lang: sourceLang, target_lang: targetLang, entries, entries_format: 'tsv',
    }],
  });
  return data.glossary_id;
}

async function translate(text, glossaryIds) {
  return post('/v2/translate', {
    text: [text], source_lang: 'EN', target_lang: 'DE', glossary_ids: glossaryIds,
  });
}

describe('glossary_ids', () => {
  let enDeHello;
  let enDeWorld;
  let enFrHello;

  beforeAll(async () => {
    enDeHello = await createGlossary('en-de hello', 'en', 'de', 'hello\tHallo');
    enDeWorld = await createGlossary('en-de world', 'en', 'de', 'world\tWelt');
    enFrHello = await createGlossary('en-fr hello', 'en', 'fr', 'hello\tBonjour');
  });

  it('applies a single glossary', async () => {
    const { status, data } = await translate('hello', [enDeHello]);
    expect(status).toBe(200);
    expect(data.translations[0].text).toBe('Hallo');
  });

  it('applies the first matching glossary when several are given', async () => {
    const { status, data } = await translate('hello', [enDeHello, enDeWorld]);
    expect(status).toBe(200);
    expect(data.translations[0].text).toBe('Hallo');
  });

  it('falls through to a later glossary when the earlier one has no entry', async () => {
    const { status, data } = await translate('world', [enDeHello, enDeWorld]);
    expect(status).toBe(200);
    expect(data.translations[0].text).toBe('Welt');
  });

  it('skips a glossary that has no dictionary for the requested language pair', async () => {
    const { status, data } = await translate('hello', [enFrHello, enDeHello]);
    expect(status).toBe(200);
    expect(data.translations[0].text).toBe('Hallo');
  });

  it('rejects glossary_id and glossary_ids together', async () => {
    const { status } = await post('/v2/translate', {
      text: ['hello'],
      source_lang: 'EN',
      target_lang: 'DE',
      glossary_id: enDeHello,
      glossary_ids: [enDeWorld],
    });
    expect(status).toBe(400);
  });
});
