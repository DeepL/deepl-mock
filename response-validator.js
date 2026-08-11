// Copyright 2025 DeepL SE (https://www.deepl.com)
// Use of this source code is governed by an MIT
// license that can be found in the LICENSE file.

const DEFAULT_SPEC_URL = 'https://raw.githubusercontent.com/DeepLcom/openapi/main/openapi.yaml';

// Captured from the parsed spec during validator install, surfaced in the
// startup banner so logs show which spec version validation ran against.
let loadedSpecVersion;

// Routes that should bypass spec validation. Each pattern is matched
// against req.path with RegExp#test. Each entry is here for one of three
// reasons:
//   - mock-only / not part of the real DeepL API
//   - response shape conflicts with the validator (multipart upload, binary
//     download stream)
//   - served by PROD but not yet in the spec
const VALIDATION_IGNORED_PATHS = [
  /^\/v2\/translate_secondary$/, // mock-only test-helper route
  /^\/v2\/document$/, // multipart upload — incompatible with the validator
  // Binary download streamed via res.download(); the validator would try to
  // parse the Buffer body against the JSON schema and false-positive.
  /^\/v2\/document\/[^/]+\/result$/,
  /^\/healthz$/, // mock-only liveness endpoint
  /^\/__session__\//, // mock-only test helpers (e.g. last-request)
  // Translation memory management endpoints. These are fully specified in
  // api-docs, but the published spec this validator defaults to still only
  // describes GET /v3/translation_memories, so every other translation memory
  // request would fail validation with "not found". Drop this entry once the
  // published spec catches up — the mock already conforms to the api-docs
  // definitions, verified by running the SDK suites against it with
  // DEEPL_MOCK_SPEC_PATH pointed at api-reference/openapi.yaml. Note the
  // trailing `/.`, which keeps the in-spec list endpoint validated.
  /^\/v3\/translation_memories\/./,
  // Mock stand-ins for the Asset Store URLs used by translation memory
  // import/export jobs — not part of the DeepL API.
  /^\/__upload__\//,
  /^\/__download__\//,
];

// Truly mock-internal paths that should also bypass request capture and 5xx
// fault injection — narrower than VALIDATION_IGNORED_PATHS, which includes
// real DeepL API paths excluded from spec validation for unrelated reasons
// (binary bodies, not-yet-in-spec). SDK tests must be able to drive 5xx
// retries and capture on those real endpoints.
const MOCK_ONLY_PATHS = [
  /^\/healthz$/,
  /^\/__session__\//,
  /^\/__upload__\//,
  /^\/__download__\//,
];

function isMockOnlyPath(p) {
  return MOCK_ONLY_PATHS.some((re) => re.test(p));
}

async function loadSpecText() {
  const { DEEPL_MOCK_SPEC_URL: specUrl, DEEPL_MOCK_SPEC_PATH: specPath } = process.env;

  if (specUrl && specPath) {
    throw new Error(
      'DEEPL_MOCK_SPEC_URL and DEEPL_MOCK_SPEC_PATH are mutually exclusive — set only one.',
    );
  }

  if (specPath) {
    const fs = require('fs/promises'); // eslint-disable-line global-require
    try {
      return await fs.readFile(specPath, 'utf8');
    } catch (err) {
      throw new Error(`Failed to read OpenAPI spec from ${specPath}: ${err.message}`);
    }
  }

  const url = specUrl || DEFAULT_SPEC_URL;
  try {
    const response = await fetch(url); // eslint-disable-line no-undef
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    return await response.text();
  } catch (err) {
    throw new Error(
      `Failed to fetch OpenAPI spec from ${url}: ${err.message}`
        + '. Spec validation requires the spec to be reachable.',
    );
  }
}

async function loadAndParseSpec() {
  const yaml = require('js-yaml'); // eslint-disable-line global-require
  const specText = await loadSpecText();
  try {
    // js-yaml v4's default schema is already safe (no !!js/function etc.),
    // but pass JSON_SCHEMA explicitly so static analysers don't flag the
    // load as unsafe deserialisation. JSON_SCHEMA is the most restrictive
    // standard schema — strings/numbers/bools/nulls/sequences/mappings —
    // which is all an OpenAPI spec contains.
    const parsedSpec = yaml.load(specText, { schema: yaml.JSON_SCHEMA });
    loadedSpecVersion = parsedSpec?.info?.version;
    return parsedSpec;
  } catch (err) {
    // Catches the case where the spec source returned HTTP 200 but with
    // non-YAML content (e.g. an HTML redirect/error page). yaml.load's
    // YAMLException alone makes this hard to diagnose.
    throw new Error(
      `Failed to parse OpenAPI spec as YAML: ${err.message}`
        + '. Check that DEEPL_MOCK_SPEC_URL/DEEPL_MOCK_SPEC_PATH points at a YAML document.',
    );
  }
}

/**
 * Installs express-openapi-validator response-validation middleware on the
 * given Express app when the VALIDATE_RESPONSES environment variable is set
 * to "1".  The middleware loads the OpenAPI spec at startup, validates every
 * response body strictly, and lets unknown request headers / query parameters
 * through (they are test infrastructure, not part of the spec).
 *
 * Spec source (pick one; defaults to the public DeepL spec on GitHub):
 *   - DEEPL_MOCK_SPEC_URL   — fetch spec from this URL
 *   - DEEPL_MOCK_SPEC_PATH  — read spec from this local file
 *
 * Mock-only routes (paths that only exist in deepl-mock, not in the real
 * DeepL API) are excluded via ignorePaths so the validator does not interfere
 * with them.
 */
async function installResponseValidator(app) {
  if (process.env.VALIDATE_RESPONSES !== '1') {
    return;
  }

  // Lazy: only load when validation is enabled, keeps deps out of default startup.
  const OpenApiValidator = require('express-openapi-validator'); // eslint-disable-line global-require

  console.log('Loading OpenAPI spec for response validation...');
  const apiSpec = await loadAndParseSpec();

  app.use(
    OpenApiValidator.middleware({
      apiSpec,
      validateApiSpec: false,
      validateRequests: false,
      validateResponses: true,
      ignorePaths: (p) => VALIDATION_IGNORED_PATHS.some((re) => re.test(p)),
    }),
  );

  console.log('Response validation enabled against OpenAPI spec.');
}

/**
 * Installs express-openapi-validator request-validation middleware on the
 * given Express app when VALIDATE_REQUESTS=1. Mirrors installResponseValidator
 * but on the request side: each incoming request's body, query and path params
 * are validated against the spec for the matched operation. Failures surface
 * as 4xx with the spec-validation error structured in the body via
 * validationErrorHandler.
 *
 * Per-test escape hatch: requests in a session created with
 * mock-server-session-allow-extra-body=1 bypass the validator. Intended for
 * tests that deliberately send non-spec-conforming bodies (e.g. the
 * extra_body_parameters fixtures across client libraries).
 */
async function installRequestValidator(app) {
  if (process.env.VALIDATE_REQUESTS !== '1') {
    return;
  }

  const OpenApiValidator = require('express-openapi-validator'); // eslint-disable-line global-require

  console.log('Loading OpenAPI spec for request validation...');
  const apiSpec = await loadAndParseSpec();

  const validators = OpenApiValidator.middleware({
    apiSpec,
    validateApiSpec: false,
    // coerceTypes: true so URL-query / path / form-urlencoded values pass
    // validation against typed schemas (prod accepts these; we should too).
    validateRequests: {
      allowUnknownQueryParameters: false,
      coerceTypes: true,
    },
    validateResponses: false,
    ignorePaths: (p) => VALIDATION_IGNORED_PATHS.some((re) => re.test(p)),
  });

  // Wrap each validator middleware so a session with allow_extra_body set
  // bypasses request validation entirely for that session's requests. The
  // wrap is per-middleware (rather than around the whole chain) so each
  // entry in the array still gets a chance to set up its own state.
  validators.forEach((v) => {
    app.use((req, res, next) => {
      if (req.session?.allow_extra_body) {
        return next();
      }
      return v(req, res, next);
    });
  });

  console.log('Request validation enabled against OpenAPI spec.');
}

/**
 * Express error handler that surfaces spec-validation failures (both request
 * and response) as structured JSON including the specific field and schema
 * that failed.
 */
function validationErrorHandler(err, req, res, next) {
  if (res.headersSent) {
    next(err);
    return;
  }
  if (err.status && err.errors) {
    console.error(
      `Spec validation error on ${req.method} ${req.path}:`,
      JSON.stringify(err.errors, null, 2),
    );
    res.status(err.status).json({
      message: err.message,
      errors: err.errors,
    });
  } else {
    next(err);
  }
}

/**
 * Returns a human-readable label for where the OpenAPI spec is loaded from,
 * for the startup banner.
 */
function specSource() {
  const { DEEPL_MOCK_SPEC_URL: specUrl, DEEPL_MOCK_SPEC_PATH: specPath } = process.env;
  if (specPath) return `file ${specPath}`;
  if (specUrl) return `url ${specUrl}`;
  return `url ${DEFAULT_SPEC_URL} (default)`;
}

/**
 * Logs a single, grep-able banner stating whether OpenAPI spec validation is
 * active and against which spec. Call once at startup AFTER the validators are
 * installed, so an "ENABLED" banner also certifies the spec loaded.
 */
function logValidationState() {
  const requests = process.env.VALIDATE_REQUESTS === '1';
  const responses = process.env.VALIDATE_RESPONSES === '1';
  if (!requests && !responses) {
    console.log(
      'deepl-mock: OpenAPI spec validation DISABLED '
        + '(set VALIDATE_REQUESTS=1 and/or VALIDATE_RESPONSES=1 to enable).',
    );
    return;
  }
  const versionSuffix = loadedSpecVersion ? ` version ${loadedSpecVersion}` : '';
  console.log(
    `deepl-mock: OpenAPI spec validation ENABLED (requests=${requests ? 'on' : 'off'}, `
      + `responses=${responses ? 'on' : 'off'}) using spec ${specSource()}${versionSuffix}.`,
  );
}

module.exports = {
  installResponseValidator,
  installRequestValidator,
  validationErrorHandler,
  isMockOnlyPath,
  logValidationState,
};
