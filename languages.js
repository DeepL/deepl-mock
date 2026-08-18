// Copyright 2022 DeepL SE (https://www.deepl.com)
// Use of this source code is governed by an MIT
// license that can be found in the LICENSE file.

const { convertToBcp47 } = require('./util');

const langListConfig = require('./config/languages/language-list.json');
const translateTextConfig = require('./config/languages/product-translate-text.json');
const translateDocumentConfig = require('./config/languages/product-translate-document.json');
const writeConfig = require('./config/languages/product-write.json');
const voiceConfig = require('./config/languages/product-voice.json');
const glossaryConfig = require('./config/languages/product-glossary.json');
const styleRulesConfig = require('./config/languages/product-style-rules.json');
const translationMemoryConfig = require('./config/languages/product-translation-memory.json');
const mockTexts = require('./config/languages/mock-translate-texts.json');

const resourceConfigs = {
  translate_text: translateTextConfig,
  translate_document: translateDocumentConfig,
  write: writeConfig,
  voice: voiceConfig,
  glossary: glossaryConfig,
  style_rules: styleRulesConfig,
  translation_memory: translationMemoryConfig,
};

const targetOnlySet = new Set(langListConfig.TargetOnlyLanguages);
const hideFromV2Set = new Set(langListConfig.HideFromV2Endpoint);
const hideFromV2TargetSet = new Set(langListConfig.HideFromV2TargetEndpoint);

// Map: bcp47-code → { Name, V2TargetName? }
const langInfoMap = new Map();
langListConfig.Languages.forEach((lang) => {
  langInfoMap.set(lang.Code, lang);
});

const translateTextSupportedSet = new Set(translateTextConfig.SupportedLanguages);

// Glossary product
const glossaryLanguages = glossaryConfig.SupportedLanguages;
const glossaryLanguageSet = new Set(glossaryLanguages);
const glossaryLanguagePairs = glossaryLanguages.flatMap(
  (source) => glossaryLanguages
    .filter((target) => target !== source)
    .map((target) => ({ source_lang: source, target_lang: target })),
);

// Per-feature language sets built from translate_text config
function featureLangSet(config, featureName) {
  const feature = config.Features.find((f) => f.Name === featureName);
  if (!feature) return new Set();
  if (!feature.Languages) return null; // null = applies to all supported languages
  return new Set(feature.Languages);
}

const formalityLangs = featureLangSet(translateTextConfig, 'formality');
const writeProductSet = new Set(writeConfig.SupportedLanguages);
const writingStyleLangs = featureLangSet(writeConfig, 'writing_style');
const writingToneLangs = featureLangSet(writeConfig, 'tone');

function norm(langCode) {
  return convertToBcp47(langCode);
}

function getLanguageName(langCode) {
  if (langCode === undefined) return true;
  return langInfoMap.get(norm(langCode))?.Name;
}

function isSourceLanguage(langCode) {
  if (langCode === undefined) return true;
  const code = norm(langCode);
  return translateTextSupportedSet.has(code) && !targetOnlySet.has(code);
}

function isTargetLanguage(langCode) {
  if (langCode === undefined) return false;
  return translateTextSupportedSet.has(norm(langCode));
}

function isGlossaryLanguage(langCode) {
  if (langCode === undefined) return false;
  return glossaryLanguageSet.has(norm(langCode));
}

function isGlossarySupportedLanguagePair(sourceLang, targetLang) {
  if (sourceLang === undefined || targetLang === undefined) return false;
  return glossaryLanguageSet.has(norm(sourceLang)) && glossaryLanguageSet.has(norm(targetLang));
}

function supportsFormality(langCode, formality) {
  if (langCode === undefined) return false;
  if (formality === 'default' || (formality !== undefined && formality.startsWith('prefer_'))) {
    return true;
  }
  const code = norm(langCode);
  return formalityLangs !== null && formalityLangs.has(code);
}

function supportsWrite(langCode) {
  if (langCode === undefined) return false;
  return writeProductSet.has(norm(langCode));
}

function supportsWritingStyle(langCode, style) {
  if (langCode === undefined) return false;
  if (style.startsWith('prefer_') || style === 'default') return true;
  const code = norm(langCode);
  return writingStyleLangs !== null && writingStyleLangs.has(code);
}

function supportsWritingTone(langCode, tone) {
  if (langCode === undefined) return false;
  if (tone.startsWith('prefer_') || tone === 'default') return true;
  const code = norm(langCode);
  return writingToneLangs !== null && writingToneLangs.has(code);
}

function getSourceLanguages() {
  return langListConfig.Languages
    .filter((lang) => !targetOnlySet.has(lang.Code)
      && !hideFromV2Set.has(lang.Code))
    .map((lang) => ({
      language: lang.Code.toUpperCase(),
      name: lang.Name,
    }));
}

function getTargetLanguages() {
  return langListConfig.Languages
    .filter((lang) => !hideFromV2Set.has(lang.Code)
      && !hideFromV2TargetSet.has(lang.Code))
    .map((lang) => ({
      language: lang.Code.toUpperCase(),
      name: lang.V2TargetName ?? lang.Name,
      supports_formality: formalityLangs !== null && formalityLangs.has(lang.Code),
    }));
}

function getGlossaryLanguagePairs() {
  return glossaryLanguagePairs;
}

function getBaseLanguageCode(langCode) {
  if (langCode.toUpperCase() === 'EN-GB' || langCode.toUpperCase() === 'EN-US') return 'EN';
  if (langCode.toUpperCase() === 'PT-BR' || langCode.toUpperCase() === 'PT-PT') return 'PT';
  if (langCode.toUpperCase() === 'ZH-HANS' || langCode.toUpperCase() === 'ZH-HANT') return 'ZH';
  if (langCode.toUpperCase() === 'ES-419') return 'ES';
  return langCode;
}

function translateLine(input, sourceLang, targetLang, glossary) {
  if (input === '') return '';

  if (glossary) {
    const glossaryResult = glossary.translate(input, sourceLang, targetLang);
    if (glossaryResult) return glossaryResult;
  }

  return mockTexts[norm(targetLang)] ?? '';
}

function translate(input, targetLang, sourceLangIn, glossary) {
  let sourceLang = sourceLangIn;
  if (!sourceLang) {
    sourceLang = 'EN';
    Object.entries(mockTexts).some(([code, text]) => {
      if (input.startsWith(text)) {
        sourceLang = code.toUpperCase();
        return true;
      }
      return false;
    });
  }

  const text = input.split('\n').map((line) => translateLine(line, sourceLang, targetLang, glossary)).join('\n');

  const textShort = text.length < 50 ? text : `${text.slice(0, 47)}...`;
  const inputShort = input.length < 50 ? input : `${input.slice(0, 47)}...`;
  console.log(`Translated "${inputShort}" to "${textShort}"`);
  return { detected_source_language: sourceLang, text };
}

function rephrase(_, targetLang) {
  return {
    text: mockTexts[norm(targetLang)] ?? '',
    detected_source_language: targetLang.split('-')[0],
    target_language: targetLang,
  };
}

// The spec declares the same response shape for correct as for rephrase, so this returns the same
// canned text. Worth knowing when writing client-library tests: because the two bodies are
// identical, a library that pointed its correctText method at /v2/write/rephrase would still pass.
// Assert the request path, not just the response.
function correct(_, targetLang) {
  return {
    text: mockTexts[norm(targetLang)] ?? '',
    detected_source_language: targetLang.split('-')[0],
    target_language: targetLang,
  };
}

const VALID_RESOURCES = [
  'translate_text', 'translate_document', 'glossary', 'voice', 'write', 'style_rules',
  'translation_memory',
];

function getV3Resources() {
  return VALID_RESOURCES.map((name) => {
    const config = resourceConfigs[name];
    const features = config.Features
      .map((f) => {
        const feat = { name: f.Name };
        if (f.RequiredOnSource) feat.needs_source_support = true;
        if (f.RequiredOnTarget) feat.needs_target_support = true;
        return feat;
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    return { name, features };
  });
}

// Per-language features are derived from coarse config rules, so feature
// membership is spec-valid but does not mirror prod exactly (e.g. source-side
// features like auto_detection are not emitted per-language). Identity and
// usable_as_source/target are accurate.
function getV3Languages(resource) {
  const config = resourceConfigs[resource];

  return config.SupportedLanguages.map((code) => {
    const langInfo = langInfoMap.get(code);
    const name = langInfo?.Name ?? code;
    const usableAsSource = !targetOnlySet.has(code);
    const features = {};

    config.Features.forEach((feature) => {
      const coveredByLang = !feature.Languages || feature.Languages.includes(code);
      if (coveredByLang) features[feature.Name] = { status: 'stable' };
    });

    return {
      lang: convertToBcp47(code),
      name,
      status: 'stable',
      usable_as_source: usableAsSource,
      usable_as_target: true,
      features,
    };
  });
}

module.exports = {
  getLanguageName,
  isGlossaryLanguage,
  isSourceLanguage,
  getSourceLanguages,
  isTargetLanguage,
  supportsFormality,
  supportsWrite,
  supportsWritingStyle,
  supportsWritingTone,
  getTargetLanguages,
  getGlossaryLanguagePairs,
  getBaseLanguageCode,
  isGlossarySupportedLanguagePair,
  translate,
  rephrase,
  correct,
  VALID_RESOURCES,
  getV3Languages,
  getV3Resources,
};
