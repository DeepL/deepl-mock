// Copyright 2022 DeepL SE (https://www.deepl.com)
// Use of this source code is governed by an MIT
// license that can be found in the LICENSE file.

const express = require('express');
const httpProxy = require('http-proxy');

const app = express();

// parsing form x-www-form-urlencoded request bodies
const qs = require('qs');

const qsparse = qs.parse;
qs.parse = (str, options) => qsparse(str, {
  ...options,
  allowDots: true,
});
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const nocache = require('nocache');

app.use(nocache());

const fileUpload = require('express-fileupload');

app.use(fileUpload({
  createParentPath: true,
}));

const morgan = require('morgan');
// Logging utility
app.use(morgan('dev')); // Developer-style formatting

const sessions = require('./sessions');

app.use(sessions());

const auth = require('./auth');
const documents = require('./documents');
const glossariesV2 = require('./glossariesV2');
const glossariesV3 = require('./glossariesV3');
const languages = require('./languages');
const styleRules = require('./styleRules');
const translationMemories = require('./translationMemories');
const { writingStyles, WritingStyle } = require('./writing_styles');
const { writingTones, WritingTone } = require('./writing_tones');
const util = require('./util');
const {
  installResponseValidator,
  installRequestValidator,
  validationErrorHandler,
  isMockOnlyPath,
  logValidationState,
} = require('./response-validator');

// Add X-Trace-ID header to all responses
app.use((req, res, next) => {
  const traceId = util.generateRandomHexString(32);
  res.setHeader('X-Trace-ID', traceId);
  next();
});

// Per-session capture of the most recent received request. Reads back from
// GET /__session__/last-request. The 'finish' hook lets us register here
// without caring whether body parsers run before or after this middleware —
// req.body / req.query are populated by the time the response is sent.
function captureRequest(req, res, next) {
  if (isMockOnlyPath(req.path)) {
    return next();
  }
  res.on('finish', () => {
    if (!req.session || typeof req.session !== 'object' || !req.headers['mock-server-session']) {
      return;
    }
    req.session.last_request = {
      method: req.method,
      path: req.path,
      headers: { ...req.headers },
      query: { ...req.query },
      body: req.body,
    };
  });
  return next();
}
app.use(captureRequest);

// Transient 5xx fault injection for retry-on-5xx test scenarios.
// Mirrors the existing 429 mechanism but applies to every API endpoint so
// SDKs can drive their retry logic on any request the test cares about.
function respondWith5xx(req, res, next) {
  if (isMockOnlyPath(req.path)) {
    return next();
  }
  if (req.session?.respond_5xx_count > 0) {
    req.session.respond_5xx_count -= 1;
    const configured = req.session.respond_5xx_status;
    const status = Number.isInteger(configured) && configured >= 500 && configured <= 599
      ? configured
      : 503;
    res.status(status).send();
    return undefined;
  }
  return next();
}
app.use(respondWith5xx);

const envVarPort = 'DEEPL_MOCK_SERVER_PORT';
const envVarProxyPort = 'DEEPL_MOCK_PROXY_SERVER_PORT';

const port = Number(process.env[envVarPort]);
const proxyPort = Number(process.env[envVarProxyPort]);

if (Number.isNaN(port)) {
  console.error(`The ${envVarPort} environment variable must be defined as the port number.`);
  process.exit(2);
}
if (Number.isNaN(proxyPort)) {
  console.info(`The ${envVarProxyPort} environment variable is not defined, no proxy will be used.`);
}

function requireUserAgent(req, res, next) {
  const userAgentHeader = req.headers['user-agent'];
  if ((userAgentHeader === undefined || userAgentHeader === '') && !req.session?.allow_missing_user_agent) {
    // Give no response and do not continue with next handler
    res.status(400).send({ message: 'User-Agent header missing.' });
    return undefined;
  }
  return next();
}

function getParam(req, name, options) {
  let v = req.body?.[name] ?? req.query[name];

  if (options?.params) {
    v = req.params[name];
  }

  if (options?.multi) {
    if (v === undefined) v = [];
    v = Array.isArray(v) ? v : [v];
    if (options?.required && v.length === 0) {
      if (options?.newErrorMessage) throw new util.HttpError(`Missing or invalid argument: ${name}'`);
      throw new util.HttpError(`Parameter '${name}' not specified`);
    }
  } else {
    v = Array.isArray(v) ? v[0] : v;
    if (options?.required && v === undefined) {
      if (options?.newErrorMessage) throw new util.HttpError(`Missing or invalid argument: ${name}'`);
      throw new util.HttpError(`Parameter '${name}' not specified`);
    } else if (v === undefined) {
      return options?.default;
    }

    if (options?.lower && v) v = v.toLowerCase();
    else if (options?.upper && v) v = v.toUpperCase();

    if (options?.validator && options?.validator(v) === false) {
      if (options?.newErrorMessage) throw new util.HttpError(`Missing or invalid argument: ${name}'`);
      throw new util.HttpError(`Value for '${name}' not supported.`);
    }
    if (options?.allowedValues && !options?.allowedValues.includes(v)) {
      if (options?.newErrorMessage) throw new util.HttpError(`Missing or invalid argument: ${name}'`);
      throw new util.HttpError(`Value for '${name}' not supported.`);
    }
  }

  return v;
}

function getParamFormality(req, targetLang) {
  return getParam(req, 'formality', {
    default: 'default',
    allowedValues: ['less', 'more', 'default', 'prefer_less', 'prefer_more'],
    validator: (formality) => {
      if (!languages.supportsFormality(targetLang, formality)) {
        throw new util.HttpError(`Target language '${targetLang}' doesn't support formality.`, 400);
      }
    },
  });
}

function getParamWritingStyle(req, targetLang) {
  return getParam(req, 'writing_style', {
    allowedValues: writingStyles,
    lower: true,
    validator: (style) => {
      if (!languages.supportsWritingStyle(targetLang, style)) {
        throw new util.HttpError(`Language ${targetLang.toLowerCase()} does not support setting a writing style.`, 400);
      }
    },
  });
}

function getParamTone(req, targetLang) {
  return getParam(req, 'tone', {
    allowedValues: writingTones,
    lower: true,
    validator: (tone) => {
      if (!languages.supportsWritingTone(targetLang, tone)) {
        throw new util.HttpError(`Language ${targetLang.toLowerCase()} does not support setting a tone.`, 400);
      }
    },
  });
}

function resolveGlossary(glossaryId, authKey) {
  try {
    return glossariesV2.getGlossary(glossaryId, authKey);
  } catch {
    return glossariesV3.getGlossary(glossaryId, authKey);
  }
}

function getParamGlossary(req, sourceLang) {
  const { authKey } = req.user_account;
  const glossaryId = getParam(req, 'glossary_id',
    { validator: (id) => (id === undefined || glossariesV2.isValidGlossaryId(id)) });

  // glossary_ids may be sent as a JSON array, a repeated form parameter, or a
  // comma-separated string. Normalise all of these into a flat list of IDs.
  const glossaryIdsRaw = getParam(req, 'glossary_ids', { multi: true });
  const glossaryIds = glossaryIdsRaw
    .flatMap((value) => String(value).split(','))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  if (glossaryId !== undefined && glossaryIds.length > 0) {
    throw new util.HttpError('Parameters glossary_id and glossary_ids cannot be used together', 400);
  }

  let ids = [];
  if (glossaryIds.length > 0) {
    ids = glossaryIds;
  } else if (glossaryId !== undefined) {
    ids = [glossaryId];
  }

  if (ids.length === 0) {
    return undefined;
  }

  if (sourceLang === undefined) {
    throw new util.HttpError('Use of a glossary requires the source_lang parameter to be specified', 400);
  }

  if (ids.length > 5) {
    throw new util.HttpError('Parameter glossary_ids must not contain more than 5 glossary IDs', 400);
  }

  ids.forEach((id) => {
    if (!glossariesV2.isValidGlossaryId(id)) {
      throw new util.HttpError("Value for 'glossary_ids' not supported.", 400);
    }
  });

  const glossaries = ids.map((id) => resolveGlossary(id, authKey));

  if (glossaries.length === 1) {
    return glossaries[0];
  }

  // Combine multiple glossaries: apply each in order, first match wins. The language arguments
  // have to be forwarded, because a v3 glossary picks its dictionary from them. A glossary with no
  // dictionary for this pair is a miss rather than a failure: it signals that by throwing a 404,
  // and combining glossaries across language pairs is the point of glossary_ids.
  return {
    translate: (input, translateSourceLang, translateTargetLang) => {
      for (let i = 0; i < glossaries.length; i += 1) {
        let result = null;
        try {
          result = glossaries[i].translate(input, translateSourceLang, translateTargetLang);
        } catch (err) {
          if (!(err instanceof util.HttpError) || err.status() !== 404) throw err;
        }
        if (result !== null && result !== undefined) {
          return result;
        }
      }
      return null;
    },
  };
}

function getParamStyleRule(req, targetLang) {
  const { authKey } = req.user_account;
  const styleId = getParam(req, 'style_id',
    { validator: (id) => (id === undefined || styleRules.isValidStyleId(id)) });
  if (styleId !== undefined) {
    const styleRule = styleRules.getStyleRule(styleId, authKey);
    const styleRuleLang = languages.getBaseLanguageCode(styleRule.language.toUpperCase());
    const requestTargetLang = languages.getBaseLanguageCode(targetLang.toUpperCase());
    if (styleRuleLang !== requestTargetLang) {
      throw new util.HttpError('Style rule language does not match the translate request target language', 400);
    }
    return styleRule;
  }
  return undefined;
}

function getParamTranslationMemory(req, targetLang) {
  const { authKey } = req.user_account;
  const tmId = getParam(req, 'translation_memory_id', {
    validator: (id) => (
      id === undefined || translationMemories.isValidTranslationMemoryId(id)
    ),
  });
  const threshold = getParam(req, 'translation_memory_threshold');
  if (threshold !== undefined) {
    const thresholdNum = Number.parseInt(threshold, 10);
    if (Number.isNaN(thresholdNum) || thresholdNum < 0 || thresholdNum > 100) {
      throw new util.HttpError('Parameter "translation_memory_threshold" must be an integer between 0 and 100', 400);
    }
  }
  if (tmId !== undefined) {
    const tm = translationMemories.getTranslationMemory(tmId, authKey);
    const requestTargetLang = languages.getBaseLanguageCode(targetLang.toUpperCase());
    const tmTargetLangs = tm.targetLanguages
      .map((lang) => languages.getBaseLanguageCode(lang.toUpperCase()));
    if (!tmTargetLangs.includes(requestTargetLang)) {
      throw new util.HttpError(`Translation Memory ${tmId} does not support the target language ${targetLang}`, 404);
    }
    return tm;
  }
  return undefined;
}

function getParamGlossaryId(req, required = true) {
  return getParam(req, 'glossary_id',
    {
      params: true,
      required,
      validator: (id) => (id === undefined || glossariesV2.isValidGlossaryId(id)),
    });
}

function getParamSourceLang(req, required = true) {
  return getParam(req, 'source_lang',
    {
      required,
      upper: true,
      validator: languages.isGlossaryLanguage,
    });
}

function getParamTargetLang(req, required = true) {
  return getParam(req, 'target_lang',
    {
      required,
      upper: true,
      validator: languages.isGlossaryLanguage,
    });
}

function getParamDictionaries(req, required = true) {
  const glossaryDicts = getParam(req, 'dictionaries', {
    required, multi: true,
  });
  return glossaryDicts.map((glossaryDict) => ({
    sourceLang: glossaryDict.source_lang,
    targetLang: glossaryDict.target_lang,
    entries: glossaryDict.entries,
    entriesFormat: glossaryDict.entries_format,
  }));
}

function checkLimit(usage, type, request) {
  /* eslint-disable no-param-reassign */
  // Note: this function modifies the usage argument, incrementing the count used
  const count = `${type}_count`;
  const limit = `${type}_limit`;

  if (usage[limit] === undefined) return true;
  if (usage[count] + request > usage[limit]) return false;

  usage[count] += request;
  return true;
  /* eslint-enable no-param-reassign */
}

async function handleLanguages(req, res) {
  try {
    const paramType = getParam(req, 'type', {
      default: 'source',
      validator: (type) => {
        if (!['source', 'target'].includes(type)) {
          throw new Error("Parameter 'type' is invalid. 'source' and 'target' are valid values.");
        }
      },
    });

    if (paramType === 'target') {
      res.send(languages.getTargetLanguages());
    } else {
      res.send(languages.getSourceLanguages());
    }
  } catch (err) {
    res.status(400).send({ message: err.message });
  }
}

async function handleUsage(req, res) {
  const { usage } = req.user_account;

  // Create the base response with character count and limit
  const response = {
    character_count: usage.character_count,
    character_limit: usage.character_limit,

    // Additional fields that will be omitted from response if undefined
    document_limit: usage.document_limit,
    document_count: usage.document_count,
    team_document_limit: usage.team_document_limit,
    team_document_count: usage.team_document_count,
  };

  // For Pro accounts, include additional fields
  if (!req.user_account.authKey.endsWith(':fx')) {
    response.api_key_character_count = usage.character_count;
    response.api_key_character_limit = usage.character_limit;
    response.start_time = usage.start_time;
    response.end_time = usage.end_time;

    // Add products array for Pro accounts
    response.products = [
      {
        product_type: 'translate',
        api_key_character_count: usage.character_count,
        character_count: usage.character_count,
      },
      {
        product_type: 'speechToText',
        billing_unit: 'minutes',
        api_key_unit_count: 0,
        account_unit_count: 0,
        api_key_character_count: 0,
        character_count: 0,
      },
      {
        product_type: 'speechToSpeech',
        billing_unit: 'minutes',
        api_key_unit_count: 0,
        account_unit_count: 0,
        api_key_character_count: 0,
        character_count: 0,
      },
    ];

    response.speech_to_speech_minutes_count = 0;
    response.speech_to_speech_minutes_limit = 0;
  }

  res.send(response);
}

async function handleTranslate(req, res) {
  try {
    const targetLang = getParam(req, 'target_lang', {
      upper: true, validator: languages.isTargetLanguage,
    });
    const sourceLang = getParam(req, 'source_lang', {
      upper: true, validator: languages.isSourceLanguage,
    });
    const textArray = getParam(req, 'text', { multi: true, required: true });
    const glossary = getParamGlossary(req, sourceLang);

    // The following parameters are validated but not used by the mock server
    getParam(req, 'split_sentences', { default: '1', allowedValues: ['0', '1', 'nonewlines'] });
    getParam(req, 'preserve_formatting', { default: '0', allowedValues: ['0', '1', true, false] });
    getParamFormality(req, targetLang);
    getParam(req, 'tag_handling', { default: 'xml', allowedValues: ['html', 'xml'] });
    getParam(req, 'tag_handling_version', { allowedValues: ['v1', 'v2'] });
    getParam(req, 'outline_detection', { default: '1', allowedValues: ['0', '1', true, false] });
    const showBilledCharacters = getParam(req, 'show_billed_characters', { default: false, allowedValues: ['0', '1', true, false] });
    const modelType = getParam(req, 'model_type', { allowedValues: ['quality_optimized', 'latency_optimized', 'prefer_quality_optimized'] });
    getParamStyleRule(req, targetLang);
    getParamTranslationMemory(req, targetLang);

    // Calculate the character count of the requested translation
    const totalCharacters = textArray.reduce((total, text) => (total + text.length), 0);

    // Check if session is configured to respond with 429: too-many-requests
    if (req.session.respond_429_count > 0) {
      req.session.respond_429_count -= 1;
      res.status(429).send();
    } else if (!checkLimit(req.user_account.usage, 'character', totalCharacters)) {
      res.status(456).send({ message: 'Quota for this billing period has been exceeded.' });
    } else {
      const body = {
        translations: textArray.map((text) => {
          const result = languages.translate(text, targetLang, sourceLang, glossary);
          if (showBilledCharacters) {
            result.billed_characters = text.length;
          }
          if (modelType) {
            result.model_type_used = 'quality_optimized';
          }
          return result;
        }),
      };
      res.status(200).send(body);
    }
  } catch (err) {
    res.status(400).send({ message: err.message });
  }
}

async function handleRephrase(req, res) {
  try {
    let targetLang = getParam(req, 'target_lang', {
      upper: true,
      validator: (langCode) => languages.isTargetLanguage(langCode)
          && languages.supportsWrite(langCode),
    });
    if (targetLang === 'EN') {
      targetLang = 'EN-US';
    } else if (targetLang === 'PT') {
      targetLang = 'PT-PT';
    }
    const textArray = getParam(req, 'text', { multi: true, required: true });

    // The following parameters are validated but not used by the mock server
    const writingStyle = getParamWritingStyle(req, targetLang);
    const tone = getParamTone(req, targetLang);
    if (writingStyle !== undefined && writingStyle !== null
        && writingStyle !== WritingStyle.DEFAULT && writingStyle !== WritingStyle.PREFER_DEFAULT
        && tone !== undefined && tone !== null
        && tone !== WritingTone.DEFAULT && tone !== WritingTone.PREFER_DEFAULT) {
      throw new util.HttpError('Bad request. Reason: Both writing_style and tone defined. Currently only style OR tone can be chosen for a single request.', 400);
    }

    // Calculate the character count of the requested text improvement
    const totalCharacters = textArray.reduce((total, text) => (total + text.length), 0);

    // Check if session is configured to respond with 429: too-many-requests
    if (req.session.respond_429_count > 0) {
      req.session.respond_429_count -= 1;
      res.status(429).send();
    } else if (
      !checkLimit(req.user_account.usage, 'character', totalCharacters)
    ) {
      res
        .status(456)
        .send({ message: 'Quota for this billing period has been exceeded.' });
    } else {
      const body = {
        improvements: textArray.map((text) => languages.rephrase(
          text,
          util.convertToBcp47(targetLang),
        )),
      };
      res.status(200).send(body);
    }
  } catch (err) {
    res.status(400).send({ message: err.message });
  }
}

// POST /v2/write/correct. Same session behaviour, quota accounting and error shapes as rephrase,
// deliberately: in the spec the two endpoints differ only in that correct has no writing_style and
// no tone, so anything else diverging here would be the mock inventing a difference.
async function handleCorrect(req, res) {
  try {
    let targetLang = getParam(req, 'target_lang', {
      upper: true,
      validator: (langCode) => languages.isTargetLanguage(langCode)
          && languages.supportsWrite(langCode),
    });
    // target_lang is optional here, unlike everywhere else in the mock: correcting spelling and
    // grammar needs no target. EN is the fallback for the same reason handleTranslate assumes it
    // when no source language is given. Note rephrase has no such fallback and throws a raw
    // TypeError on a request without target_lang; that is pre-existing and not touched here.
    if (targetLang === undefined) {
      targetLang = 'EN';
    }
    if (targetLang === 'EN') {
      targetLang = 'EN-US';
    } else if (targetLang === 'PT') {
      targetLang = 'PT-PT';
    }
    const textArray = getParam(req, 'text', { multi: true, required: true });

    const totalCharacters = textArray.reduce((total, text) => (total + text.length), 0);

    if (req.session.respond_429_count > 0) {
      req.session.respond_429_count -= 1;
      res.status(429).send();
    } else if (
      !checkLimit(req.user_account.usage, 'character', totalCharacters)
    ) {
      res
        .status(456)
        .send({ message: 'Quota for this billing period has been exceeded.' });
    } else {
      const body = {
        improvements: textArray.map((text) => languages.correct(
          text,
          util.convertToBcp47(targetLang),
        )),
      };
      res.status(200).send(body);
    }
  } catch (err) {
    res.status(400).send({ message: err.message });
  }
}

async function handleDocument(req, res) {
  try {
    const targetLang = getParam(req, 'target_lang', {
      upper: true, validator: languages.isTargetLanguage,
    });
    const sourceLang = getParam(req, 'source_lang', {
      upper: true, validator: languages.isSourceLanguage,
    });
    getParamFormality(req, targetLang);
    const glossary = getParamGlossary(req, sourceLang);
    // Validated but not otherwise used by the mock server for documents
    getParamStyleRule(req, targetLang);
    getParamTranslationMemory(req, targetLang);
    const outputFormat = getParam(req, 'output_format', { lower: true });

    if (!req.files || req.files.file === undefined) {
      res.status(400).send({ message: 'Invalid file data.' });
    } else {
      const { file } = req.files;
      try {
        // Mock server simplification: billed characters assumed to be file size
        const totalCharacters = file.size;
        if (!checkLimit(req.user_account.usage, 'character', totalCharacters)
                    || !checkLimit(req.user_account.usage, 'document', 1)
                    || !checkLimit(req.user_account.usage, 'team_document', 1)) {
          res.status(456).send({ message: 'Quota for this billing period has been exceeded.' });
        } else {
          const { authKey } = req.user_account;
          const document = await documents.createDocument(file, authKey, targetLang, sourceLang,
            glossary, outputFormat);
          res.status(200).send({
            document_id: document.id,
            document_key: document.key,
          });
          await documents.translateDocument(document, req.session);
        }
      } catch (err) {
        res.status(err.status()).send(err.body());
      }
    }
  } catch (err) {
    res.status(400).send({ message: err.message });
  }
}

async function handleDocumentStatus(req, res) {
  try {
    const { authKey } = req.user_account;
    const documentKey = getParam(req, 'document_key', { single: true });
    const document = documents.getDocument(req.params.document_id, documentKey, authKey,
      req.session);

    const body = {
      document_id: document.id,
      status: document.status,
    };

    if (document.status === 'translating') {
      body.seconds_remaining = document.seconds_remaining;
    } else if (document.status === 'done') {
      body.seconds_remaining = document.seconds_remaining;
      body.billed_characters = document.billed_characters;
    } else if (document.status === 'error') {
      body.error_message = document.error_message;
      // Field 'message' is also set for backward compatibility
      body.message = document.error_message;
    }

    res.status(200).send(body);
  } catch (err) {
    console.log(err.message);
    res.status(404).send();
  }
}

async function handleDocumentDownload(req, res) {
  try {
    const { authKey } = req.user_account;
    const documentKey = getParam(req, 'document_key', { single: true });
    const document = documents.getDocument(req.params.document_id, documentKey, authKey,
      req.session);

    if (document.status !== 'done') {
      res.status(503).send({ message: 'Document translation is not done' });
    } else {
      res.status(200);
      res.download(
        document.path_out,
        document.name_out,
        {
          headers: { 'Content-Type': document.contentType },
        },
        (err) => {
          if (err) {
            console.log(`Error occurred during file download: ${err}`);
          } else {
            documents.removeDocument(document);
          }
        },
      );
    }
  } catch {
    res.status(404).send();
  }
}

async function handleV2GlossaryList(req, res) {
  try {
    // Access glossary_id param from path, note: glossary_id is optional, so may be undefined
    const glossaryId = getParamGlossaryId(req, false);
    const { authKey } = req.user_account;

    if (glossaryId !== undefined) {
      const glossaryInfo = glossariesV2.getGlossaryInfo(glossaryId, authKey);
      res.status(200).send(glossaryInfo);
    } else {
      const glossaryList = glossariesV2.getGlossaryInfoList(authKey);
      res.status(200).send({ glossaries: glossaryList });
    }
  } catch (err) {
    console.log(err.message);
    res.status(err.status()).send();
  }
}

async function handleV3GlossaryList(req, res) {
  try {
    // Access glossary_id param from path, note: glossary_id is optional, so may be undefined
    const glossaryId = getParamGlossaryId(req, false);
    const { authKey } = req.user_account;

    if (glossaryId !== undefined) {
      const glossaryInfo = glossariesV3.getGlossaryInfo(glossaryId, authKey);
      res.status(200).send(glossaryInfo);
    } else {
      const glossaryList = glossariesV3.getGlossaryInfoList(authKey);
      res.status(200).send({ glossaries: glossaryList });
    }
  } catch (err) {
    console.log(err.message);
    res.status(err.status()).send();
  }
}

async function handleV2GlossaryEntries(req, res) {
  try {
    if (req.accepts('text/tab-separated-values')) {
      const glossaryId = getParamGlossaryId(req);
      const { authKey } = req.user_account;
      const entries = glossariesV2.getGlossaryEntries(glossaryId, authKey);
      res.contentType('text/tab-separated-values; charset=UTF-8');
      res.status(200).send(entries);
    } else {
      res.status(415).send({ message: 'No supported media type specified in Accept header' });
    }
  } catch (err) {
    console.log(err.message);
    res.status(err.status()).send();
  }
}

async function handleV3GlossaryEntries(req, res) {
  try {
    const glossaryId = getParamGlossaryId(req);
    const { authKey } = req.user_account;
    const sourceLang = getParamSourceLang(req);
    const targetLang = getParamTargetLang(req);
    const entries = glossariesV3.getDictionaryEntries(
      glossaryId,
      sourceLang,
      targetLang,
      authKey,
    );
    res.status(200).send(entries);
  } catch (err) {
    console.log(err.message);
    res.status(err.status()).send();
  }
}

function handleGlossaryLanguages(req, res) {
  try {
    res.status(200).send(
      {
        supported_languages: languages.getGlossaryLanguagePairs(),
      },
    );
  } catch (err) {
    console.log(err.message);
    res.status(err.status()).send(err.body());
  }
}

async function handleV2GlossaryCreate(req, res) {
  try {
    const { authKey } = req.user_account;

    const name = getParam(req, 'name', {
      required: true,
      newErrorMessage: true,
      validator: (value) => value.length !== 0,
    });
    const targetLang = getParam(req, 'target_lang', {
      upper: true, validator: languages.isGlossaryLanguage,
    });
    const sourceLang = getParam(req, 'source_lang', {
      upper: true, validator: languages.isGlossaryLanguage,
    });
    const entries = getParam(req, 'entries', { required: true });
    const entriesFormat = getParam(req, 'entries_format', {
      required: true,
      validator: (value) => {
        if (value !== 'tsv' && value !== 'csv') {
          throw new util.HttpError('Unsupported entry format specified', 401);
        }
      },
    });
    const glossaryInfo = await glossariesV2.createGlossary(name, authKey, targetLang, sourceLang,
      entriesFormat, entries);
    res.status(201).send(glossaryInfo);
  } catch (err) {
    console.log(err.message);
    res.status(err.status()).send(err.body());
  }
}

async function handleV3GlossaryCreate(req, res) {
  try {
    const { authKey } = req.user_account;

    const name = getParam(req, 'name', {
      required: true,
      newErrorMessage: true,
      validator: (value) => value.length !== 0,
    });
    const glossaryDicts = getParamDictionaries(req);

    const glossaryInfo = await glossariesV3.createGlossary(name, authKey, glossaryDicts);
    res.status(201).send(glossaryInfo);
  } catch (err) {
    console.log(err.message);
    res.status(err.status()).send(err.body());
  }
}

async function handleV2GlossaryDelete(req, res) {
  try {
    const glossaryId = getParamGlossaryId(req);
    const { authKey } = req.user_account;
    glossariesV2.removeGlossary(glossaryId, authKey);
    res.status(204).send();
  } catch (err) {
    console.log(err.message);
    res.status(err.status()).send();
  }
}

async function handleV3GlossaryDelete(req, res) {
  try {
    const glossaryId = getParamGlossaryId(req);
    const { authKey } = req.user_account;
    glossariesV3.removeGlossary(glossaryId, authKey);
    res.status(204).send();
  } catch (err) {
    console.log(err.message);
    res.status(err.status()).send();
  }
}

async function handleDictionaryDelete(req, res) {
  try {
    const glossaryId = getParamGlossaryId(req);
    const { authKey } = req.user_account;
    const sourceLang = getParamSourceLang(req);
    const targetLang = getParamTargetLang(req);
    glossariesV3.removeDictionary(glossaryId, sourceLang, targetLang, authKey);
    res.status(204).send();
  } catch (err) {
    console.log(err.message);
    res.status(err.status()).send();
  }
}

async function handleGlossaryPatch(req, res) {
  try {
    const glossaryId = getParamGlossaryId(req);
    const { authKey } = req.user_account;
    const name = getParam(req, 'name', {
      required: false,
      newErrorMessage: true,
      validator: (value) => value.length !== 0,
    });
    const glossaryDicts = getParamDictionaries(req, false);

    const glossary = await glossariesV3.patchGlossary(glossaryId, name, glossaryDicts, authKey);
    res.status(200).send(glossary);
  } catch (err) {
    console.log(err.message);
    res.status(err.status()).send();
  }
}

async function handleDictionaryPut(req, res) {
  try {
    const glossaryId = getParamGlossaryId(req);
    const { authKey } = req.user_account;
    const sourceLang = getParamSourceLang(req);
    const targetLang = getParamTargetLang(req);
    const entries = getParam(req, 'entries', { required: true });
    const entriesFormat = getParam(req, 'entries_format', {
      required: true,
      validator: (value) => {
        if (value !== 'tsv' && value !== 'csv') {
          throw new util.HttpError('Unsupported entry format specified', 401);
        }
      },
    });
    const glossary = await glossariesV3.putDictionary(
      glossaryId,
      sourceLang,
      targetLang,
      entries,
      entriesFormat,
      authKey,
    );
    res.status(200).send(glossary);
  } catch (err) {
    console.log(err.message);
    res.status(err.status()).send();
  }
}

async function handleStyleRuleList(req, res) {
  try {
    const { authKey } = req.user_account;
    // Handler must work in both modes: without VALIDATE_REQUESTS=1 query params
    // stay strings; with it, coerceTypes turns them into typed primitives. Dual
    // arrays accept either — same pattern as /v2/translate boolean-ish params
    // at lines 384/388/389.
    const pageSizeAllowedValues = Array.from({ length: 25 }, (_, i) => i + 1)
      .flatMap((n) => [n, String(n)]);

    const pageStr = getParam(req, 'page', { default: '0' });
    const pageSizeStr = getParam(req, 'page_size', { default: '10', allowedValues: pageSizeAllowedValues });
    const detailedStr = getParam(req, 'detailed', { default: 'false', allowedValues: ['true', 'false', true, false] });
    const page = Number.parseInt(pageStr, 10);
    const pageSize = Number.parseInt(pageSizeStr, 10);
    const detailed = detailedStr === true || detailedStr === 'true';

    // Validate page is non-negative
    if (Number.isNaN(page) || page < 0) {
      throw new util.HttpError('Parameter "page" must be a non-negative integer', 400);
    }

    const styleRuleList = styleRules.getStyleRuleInfoList(authKey, page, pageSize, detailed);
    res.status(200).send(styleRuleList);
  } catch (err) {
    console.log(err.message);
    res.status(err.status()).send();
  }
}

async function handleStyleRuleGet(req, res) {
  try {
    const { authKey } = req.user_account;
    const styleId = getParam(req, 'style_id', { params: true, required: true });

    if (!styleRules.isValidStyleId(styleId)) {
      throw new util.HttpError('Invalid style_id', 400);
    }

    const styleRuleInfo = styleRules.getStyleRuleInfo(styleId, authKey, true);
    res.status(200).send(styleRuleInfo);
  } catch (err) {
    console.log(err.message);
    res.status(err.status()).send();
  }
}

async function handleStyleRuleCreate(req, res) {
  try {
    const { authKey } = req.user_account;

    const name = getParam(req, 'name', { required: true });
    const language = getParam(req, 'language', { required: true, lower: true });
    const configuredRules = getParam(req, 'configured_rules', { default: {} });
    const customInstructions = getParam(req, 'custom_instructions', { default: [], multi: true });

    const styleRuleInfo = styleRules.createStyleRule(
      name,
      language,
      authKey,
      configuredRules,
      customInstructions,
    );
    res.status(201).send(styleRuleInfo);
  } catch (err) {
    console.log(err.message);
    res.status(err.status()).send(err.body());
  }
}

async function handleStyleRulePatch(req, res) {
  try {
    const { authKey } = req.user_account;
    const styleId = getParam(req, 'style_id', { params: true, required: true });

    if (!styleRules.isValidStyleId(styleId)) {
      throw new util.HttpError('Invalid style_id', 400);
    }

    const updates = {};
    const name = getParam(req, 'name');

    if (name !== undefined) {
      updates.name = name;
    }

    const styleRuleInfo = styleRules.patchStyleRule(styleId, authKey, updates);
    res.status(200).send(styleRuleInfo);
  } catch (err) {
    console.log(err.message);
    res.status(err.status()).send(err.body());
  }
}

async function handleConfiguredRulesUpdate(req, res) {
  try {
    const { authKey } = req.user_account;
    const styleId = getParam(req, 'style_id', { params: true, required: true });

    if (!styleRules.isValidStyleId(styleId)) {
      throw new util.HttpError('Invalid style_id', 400);
    }

    const configuredRules = req.body;

    const styleRuleInfo = styleRules.updateConfiguredRules(styleId, authKey, configuredRules);
    res.status(200).send(styleRuleInfo);
  } catch (err) {
    console.log(err.message);
    res.status(err.status()).send(err.body());
  }
}

async function handleStyleRuleDelete(req, res) {
  try {
    const { authKey } = req.user_account;
    const styleId = getParam(req, 'style_id', { params: true, required: true });

    if (!styleRules.isValidStyleId(styleId)) {
      throw new util.HttpError('Invalid style_id', 400);
    }

    styleRules.removeStyleRule(styleId, authKey);
    res.status(204).send();
  } catch (err) {
    console.log(err.message);
    res.status(err.status()).send(err.body());
  }
}

async function handleCustomInstructionCreate(req, res) {
  try {
    const { authKey } = req.user_account;
    const styleId = getParam(req, 'style_id', { params: true, required: true });

    if (!styleRules.isValidStyleId(styleId)) {
      throw new util.HttpError('Invalid style_id', 400);
    }

    const label = getParam(req, 'label', { required: true });
    const prompt = getParam(req, 'prompt', { required: true });
    const sourceLanguage = getParam(req, 'source_language', { lower: true });

    const instruction = styleRules.createCustomInstruction(
      styleId,
      authKey,
      label,
      prompt,
      sourceLanguage,
    );
    res.status(201).send(instruction);
  } catch (err) {
    console.log(err.message);
    res.status(err.status()).send(err.body());
  }
}

async function handleCustomInstructionGet(req, res) {
  try {
    const { authKey } = req.user_account;
    const styleId = getParam(req, 'style_id', { params: true, required: true });
    const instructionId = getParam(req, 'instruction_id', { params: true, required: true });

    if (!styleRules.isValidStyleId(styleId)) {
      throw new util.HttpError('Invalid style_id', 400);
    }

    const instruction = styleRules.getCustomInstruction(styleId, instructionId, authKey);
    res.status(200).send(instruction);
  } catch (err) {
    console.log(err.message);
    res.status(err.status()).send(err.body());
  }
}

async function handleCustomInstructionUpdate(req, res) {
  try {
    const { authKey } = req.user_account;
    const styleId = getParam(req, 'style_id', { params: true, required: true });
    const instructionId = getParam(req, 'instruction_id', { params: true, required: true });

    if (!styleRules.isValidStyleId(styleId)) {
      throw new util.HttpError('Invalid style_id', 400);
    }

    const label = getParam(req, 'label', { required: true });
    const prompt = getParam(req, 'prompt', { required: true });
    const sourceLanguage = getParam(req, 'source_language', { lower: true });

    const instruction = styleRules.updateCustomInstruction(
      styleId,
      instructionId,
      authKey,
      label,
      prompt,
      sourceLanguage,
    );
    res.status(200).send(instruction);
  } catch (err) {
    console.log(err.message);
    res.status(err.status()).send(err.body());
  }
}

async function handleCustomInstructionDelete(req, res) {
  try {
    const { authKey } = req.user_account;
    const styleId = getParam(req, 'style_id', { params: true, required: true });
    const instructionId = getParam(req, 'instruction_id', { params: true, required: true });

    if (!styleRules.isValidStyleId(styleId)) {
      throw new util.HttpError('Invalid style_id', 400);
    }

    styleRules.removeCustomInstruction(styleId, instructionId, authKey);
    res.status(204).send();
  } catch (err) {
    console.log(err.message);
    res.status(err.status()).send(err.body());
  }
}

async function handleTranslationMemoryList(req, res) {
  try {
    const { authKey } = req.user_account;
    // See handleStyleRuleList — dual-form accepts both string (no validator)
    // and coerced integer (VALIDATE_REQUESTS=1).
    const pageSizeAllowedValues = Array.from({ length: 25 }, (_, i) => i + 1)
      .flatMap((n) => [n, String(n)]);

    const pageStr = getParam(req, 'page', { default: '0' });
    const pageSizeStr = getParam(req, 'page_size', { default: '10', allowedValues: pageSizeAllowedValues });
    const page = Number.parseInt(pageStr, 10);
    const pageSize = Number.parseInt(pageSizeStr, 10);

    // Validate page is non-negative
    if (Number.isNaN(page) || page < 0) {
      throw new util.HttpError('Parameter "page" must be a non-negative integer', 400);
    }

    const tmList = translationMemories.getTranslationMemoryInfoList(authKey, page, pageSize);
    res.status(200).send(tmList);
  } catch (err) {
    console.log(err.message);
    res.status(err.status()).send();
  }
}

function handleHealthz(req, res) {
  res.status(200).send('ok');
}

async function handleV3Languages(req, res) {
  try {
    if (req.query.product !== undefined && req.query.resource === undefined) {
      res.status(400).send({
        message: "Bad request. Reason: The 'product' parameter has been renamed to 'resource'.",
      });
      return;
    }
    const resource = getParam(req, 'resource', {
      required: true,
      allowedValues: languages.VALID_RESOURCES,
      newErrorMessage: true,
    });
    res.status(200).send(languages.getV3Languages(resource));
  } catch (err) {
    res.status(400).send({ message: err.message });
  }
}

async function handleV3LanguageResources(req, res) {
  try {
    res.status(200).send(languages.getV3Resources());
  } catch (err) {
    res.status(400).send({ message: err.message });
  }
}

function handleSessionLastRequest(req, res) {
  if (!req.headers['mock-server-session']) {
    res.status(400).json({
      message: 'mock-server-session header required to identify the session whose last-request to read.',
    });
    return;
  }
  if (!req.session || !req.session.last_request) {
    res.status(404).json({
      message: 'No request has been captured for this session yet.',
    });
    return;
  }
  res.status(200).json(req.session.last_request);
}

async function startServer() {
  // Register all per-path body parsers first so the request validator (and
  // any spec-validation middleware) sees req.body already parsed regardless
  // of Content-Type.
  app.use('/v2/languages', express.json());
  app.use('/v2/usage', express.json());
  app.use('/v2/translate', express.json());
  app.use('/v2/translate_secondary', express.json());
  app.use('/v2/write/rephrase', express.json());
  app.use('/v2/write/correct', express.json());
  app.use('/v2/document/:document_id', express.json());
  app.use('/v2/document/:document_id/result', express.json());
  // Maximum glossary size is 10MiB, but there is some extra request overhead
  app.use('/v2/glossaries', express.json({ limit: '11mb' }));
  app.use('/v3/glossaries', express.json({ limit: '11mb' }));
  app.use('/v3/translation_memories', express.json());
  app.use('/v3/style_rules', express.json());
  app.use('/v3/languages', express.json());

  // Optionally install spec validation against the OpenAPI spec.
  //   VALIDATE_RESPONSES=1 — validates response bodies
  //   VALIDATE_REQUESTS=1  — validates request bodies/queries/path params
  // Order matters: request validator runs first so its 4xx fires before the
  // route handler; response validator wraps res for output checking.
  await installRequestValidator(app);
  await installResponseValidator(app);

  // Emit one grep-able banner of the validation state (ENABLED/DISABLED,
  // requests/responses, spec source + version). Logged after the installs so
  // an ENABLED banner also certifies the spec loaded successfully.
  logValidationState();

  app.get('/v2/languages', auth, requireUserAgent, handleLanguages);
  app.post('/v2/languages', auth, requireUserAgent, handleLanguages);

  app.get('/v2/usage', auth, requireUserAgent, handleUsage);
  app.post('/v2/usage', auth, requireUserAgent, handleUsage);

  app.get('/v2/translate', auth, requireUserAgent, handleTranslate);
  app.post('/v2/translate', auth, requireUserAgent, handleTranslate);

  // (internal only) Note that this is not a real endpoint on the DeepL API. It is only included
  // to support testing path overrides in the client libraries.
  app.post('/v2/translate_secondary', auth, requireUserAgent, handleTranslate);

  app.get('/v2/write/rephrase', auth, requireUserAgent, handleRephrase);
  app.post('/v2/write/rephrase', auth, requireUserAgent, handleRephrase);

  // The spec declares POST only. GET is registered anyway, matching rephrase and translate above:
  // the mock accepts both everywhere so client libraries can exercise their form-encoded paths.
  app.get('/v2/write/correct', auth, requireUserAgent, handleCorrect);
  app.post('/v2/write/correct', auth, requireUserAgent, handleCorrect);

  app.post('/v2/document', auth, requireUserAgent, handleDocument);

  app.get('/v2/document/:document_id', auth, requireUserAgent, handleDocumentStatus);
  app.post('/v2/document/:document_id', auth, requireUserAgent, handleDocumentStatus);

  app.get('/v2/document/:document_id/result', auth, requireUserAgent, handleDocumentDownload);
  app.post('/v2/document/:document_id/result', auth, requireUserAgent, handleDocumentDownload);

  app.get('/v2/glossary-language-pairs', auth, requireUserAgent, handleGlossaryLanguages);
  app.post('/v2/glossaries', auth, requireUserAgent, handleV2GlossaryCreate.bind(null));
  app.get('/v2/glossaries', auth, requireUserAgent, handleV2GlossaryList.bind(null));
  app.get('/v2/glossaries/:glossary_id', auth, requireUserAgent, handleV2GlossaryList.bind(null));
  app.get('/v2/glossaries/:glossary_id/entries', auth, requireUserAgent, handleV2GlossaryEntries.bind(null));
  app.delete('/v2/glossaries/:glossary_id', auth, requireUserAgent, handleV2GlossaryDelete.bind(null));

  app.post('/v3/glossaries', auth, requireUserAgent, handleV3GlossaryCreate.bind(null));
  app.get('/v3/glossaries', auth, requireUserAgent, handleV3GlossaryList.bind(null));
  app.get('/v3/glossaries/:glossary_id', auth, requireUserAgent, handleV3GlossaryList.bind(null));
  app.get('/v3/glossaries/:glossary_id/entries', auth, requireUserAgent, handleV3GlossaryEntries.bind(null));
  app.delete('/v3/glossaries/:glossary_id', auth, requireUserAgent, handleV3GlossaryDelete.bind(null));
  app.delete('/v3/glossaries/:glossary_id/dictionaries', auth, requireUserAgent, handleDictionaryDelete);
  app.patch('/v3/glossaries/:glossary_id', auth, requireUserAgent, handleGlossaryPatch);
  app.put('/v3/glossaries/:glossary_id/dictionaries', auth, requireUserAgent, handleDictionaryPut);

  app.get('/v3/translation_memories', auth, requireUserAgent, handleTranslationMemoryList.bind(null));

  app.get('/v3/style_rules', auth, requireUserAgent, handleStyleRuleList.bind(null));
  app.post('/v3/style_rules', auth, requireUserAgent, handleStyleRuleCreate.bind(null));
  app.get('/v3/style_rules/:style_id', auth, requireUserAgent, handleStyleRuleGet.bind(null));
  app.patch('/v3/style_rules/:style_id', auth, requireUserAgent, handleStyleRulePatch.bind(null));
  app.delete('/v3/style_rules/:style_id', auth, requireUserAgent, handleStyleRuleDelete.bind(null));
  app.put('/v3/style_rules/:style_id/configured_rules', auth, requireUserAgent, handleConfiguredRulesUpdate.bind(null));
  app.post('/v3/style_rules/:style_id/custom_instructions', auth, requireUserAgent, handleCustomInstructionCreate.bind(null));
  app.get('/v3/style_rules/:style_id/custom_instructions/:instruction_id', auth, requireUserAgent, handleCustomInstructionGet.bind(null));
  app.put('/v3/style_rules/:style_id/custom_instructions/:instruction_id', auth, requireUserAgent, handleCustomInstructionUpdate.bind(null));
  app.delete('/v3/style_rules/:style_id/custom_instructions/:instruction_id', auth, requireUserAgent, handleCustomInstructionDelete.bind(null));

  // More-specific sub-paths must be registered before the base /v3/languages route
  app.get('/v3/languages/resources', auth, requireUserAgent, handleV3LanguageResources);
  app.get('/v3/languages', auth, requireUserAgent, handleV3Languages);

  // Mock-internal session helper endpoints. No auth: these inspect mock state.
  app.get('/__session__/last-request', handleSessionLastRequest);

  app.get('/healthz', handleHealthz);

  app.all('/*path', (req, res) => {
    res.status(404).send();
  });

  // Error handler for spec validation failures (request and response)
  app.use(validationErrorHandler);

  const server = app.listen(port, () => {
    console.log(`DeepL API mock-server listening on port ${port}`);
  }).on('error', (error) => {
    console.error(`Error occurred while starting the server: ${error}`);
    process.exit(1);
  });

  server.keepAliveTimeout = 10 * 1000;

  if (!Number.isNaN(proxyPort)) {
    const proxyApp = express();
    const proxy = httpProxy.createProxyServer({});
    proxyApp.all('*path', (req, res) => {
      console.log('Proxying request:', req.method, req.url);
      req.headers.forwarded = `for=${req.ip}`;
      proxy.web(req, res, { target: `http://localhost:${port}` }, (err) => {
        console.log('Error while proxying request:', err);
      });
    });
    proxyApp.listen(proxyPort, () => {
      console.log(`DeepL API mock-proxy-server listening on port ${proxyPort}`);
    });
  }
}

startServer().catch((err) => {
  console.error(`Failed to start server: ${err}`);
  process.exit(1);
});
