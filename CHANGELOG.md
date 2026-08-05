# Changelog
All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]
### Added
- Support the `glossary_ids` parameter on the `/v2/translate` and `/v2/document`
  endpoints, allowing up to 5 glossaries per request. Enforces mutual exclusion
  with `glossary_id`, the `source_lang` requirement, and the 5-glossary limit.
- Validate the `style_id` and `translation_memory_id` /
  `translation_memory_threshold` parameters on the `/v2/document` endpoint,
  mirroring the existing `/v2/translate` handling (style-rule/target-language
  match, translation-memory target-language support, and threshold range).
- Add `speechToText` and `speechToSpeech` products (`billing_unit: minutes`)
  and top-level `speech_to_speech_minutes_count` /
  `speech_to_speech_minutes_limit` fields to `GET /v2/usage` responses for Pro
  accounts, matching the live API shape.
- Add `GET /v3/languages?resource=<resource>` endpoint returning the languages
  supported by a resource. Each language carries `lang`, `name`, `status`,
  `usable_as_source`, `usable_as_target`, and a `features` object keyed by
  feature name (matching the live API shape). Supported resources:
  `translate_text`, `translate_document`, `glossary`, `voice`, `write`,
  `style_rules`.
- Add `GET /v3/languages/resources` endpoint listing each resource and the
  features it supports, with `needs_source_support` / `needs_target_support`
  flags per feature.
- Add `GET /v3/translation_memories` endpoint for listing translation memories
- Add support for `translation_memory_id` and `translation_memory_threshold`
  parameters in `/v2/translate`
- Add opt-in response validation against the DeepL OpenAPI spec. Enable by
  setting `VALIDATE_RESPONSES=1`; every response body is then validated and
  schema mismatches surface as structured errors. Spec source defaults to the
  public DeepL spec on GitHub and can be overridden with `DEEPL_MOCK_SPEC_URL`
  (fetch from URL) or `DEEPL_MOCK_SPEC_PATH` (read from a local file).
- Log a startup banner stating whether OpenAPI spec validation is active
  (`VALIDATE_REQUESTS` / `VALIDATE_RESPONSES`), which spec source it loaded
  from, and the spec version, so it is unambiguous from the logs that
  validation is actually running.
- Add `mock-server-session-5xx-count` session header for simulating transient
  5xx responses (mirror of `mock-server-session-429-count`). The status code
  defaults to 503 and can be overridden with `mock-server-session-5xx-status`.
  Applies to every API endpoint so SDK retry-on-5xx behavior can be exercised
  on any request the test cares about.
- Add `GET /__session__/last-request` endpoint returning the most recent
  request captured for the session (method, path, headers, query, body).
  Lets tests assert what the SDK actually sent — including param values that
  the mock does not otherwise reflect in its response — under mock CI.
- Add opt-in request-shape validation against the DeepL OpenAPI spec. Enable
  by setting `VALIDATE_REQUESTS=1` (mirror of `VALIDATE_RESPONSES=1`); each
  request body, query and path parameter is then validated and schema
  mismatches surface as structured 4xx errors. Tests that deliberately send
  non-spec-conforming bodies can opt out per-session via the
  `mock-server-session-allow-extra-body` session header.

### Fixed
- Fix `GET /v3/style_rules` and `GET /v3/translation_memories` handlers to
  accept the coerced number/boolean query-parameter values that
  `VALIDATE_REQUESTS=1` produces. The `allowedValues` arrays previously
  hard-coded strings only, so coerced typed values failed the strict
  `includes()` check.
- Fix the default translation memory to return lowercase language codes
  (`source_language`, `target_languages`), matching the OpenAPI spec's
  `TranslationMemorySourceLanguage` and `TranslationMemoryTargetLanguage`
  enums. Without this, `VALIDATE_RESPONSES=1` rejected every
  `/v3/translation_memories` response with a strict enum-validation error.
- Enable ajv `coerceTypes: true` in the `VALIDATE_REQUESTS=1` request-validator
  config so URL query / path / form-urlencoded values pass validation when
  they cleanly coerce to the spec-declared type. Without this, every
  wire-format-forced string failed `type: integer` / `type: boolean` /
  `type: array` even though prod accepts the same payloads. See AE-629.
- Fix parsing of `custom_instructions` parameter during style rule creation to correctly handle array values
- Fix list of languages that support write, styles and tones
- Fix error message returned when a language does not support styles or tones but one is configured.
- Fix `GET /v3/glossaries/{id}/entries` to return lowercase `source_lang` /
  `target_lang`, matching the real API and the `/v3/glossaries` create/list
  responses. The handler echoed the upper-cased query parameters, so dictionary
  entries came back with a different casing than every other v3 glossary
  response.
### Security
- Bumped `qs` to `~6.15.2` to fix GHSA-q8mj-m7cp-5q26 (`qs.stringify` DoS via TypeError on null/undefined entries in comma-format arrays). Unblocks the `npm audit --production` gate on every MR pipeline.
- Updated dependencies to fix GHSA-j3q9-mxjg-w52f and GHSA-27v5-c462-wpq7 (path-to-regexp DoS vulnerability)
- Updated transitive `fast-uri` to fix GHSA-q3j6-qgpj-74h6 (path traversal via percent-encoded dot segments) and GHSA-v39h-62p7-jpjc (host confusion via percent-encoded authority delimiters)
- Updated follow-redirects to fix GHSA-r4q5-vmmm-2653 (auth header leak on cross-domain redirects)
- Bumped transitive `fast-uri` to `3.1.5` to fix GHSA-7p8r-x3mc-p8w7 (host confusion via backslash authority introducer). Unblocks the `npm audit --production` gate on the MR pipeline.

## [1.20.0] - 2026-03-17
### Added
- Added many new languages to `/v2/languages` response to match the live API.
- Add full CRUD support for `/v3/style_rules` endpoints: create, get, list, update name, and delete style rules
- Add `PUT /v3/style_rules/{style_id}/configured_rules` endpoint for updating configured rules
- Add CRUD support for custom instructions on style rules: create, get, update, and delete

### Security
- Updated dependencies to fix GHSA-w7fw-mjwx-w883 (qs ReDoS vulnerability)

## [1.19.0] - 2026-02-03
### Changed
- Update model_type_used to always be `quality_optimized` for `/translate`
- Update the error message used for using formality for unsupported languages

### Security
- Updated dependencies to fix CVE-2025-64718
- Bumped node requirement to >=18 to fix CVE-2025-15284

## [1.18.0] - 2025-12-10
### Added
- Added validation for `tag_handling_version` parameter in translate endpoint. Accepts `v1` and `v2` values.
- `/v2/usage` endpoint: Now returns additional fields: `products`, `api_key_character_count`, `api_key_character_limit`, `start_time`, and `end_time` in the response, matching the latest DeepL API spec.
- `/v3/style_rules` endpoint: Add support for listing style rules with pagination (page, page_size) and detailed response options
- Add `style_id` parameter support to `/v2/translate` endpoint for style rule validation
- Add `X-Trace-Id` response header matching live API.

## [1.17.4] - 2025-04-22
### Added
- Add support for dot notation for x-www-form-encoded requests

### Fixed
- Fix path override functionality

## [1.17.3] - 2025-03-31
### Fixed
- Fixed dictionary entry merging in v3 glossary update function.

## [1.17.2] - 2025-03-26
### Added
- Fix language code comparisons to be case-insensitive

## [1.17.1] - 2025-03-20
### Added
- Fix erroneous copyright year changes

## [1.17.0] - 2025-03-18
### Added
- Add support for the v3 glossary endpoints in the mock server

## [1.16.3] - 2025-03-05
### Added
- Add additional path for testing path overrides

## [1.16.2] - 2025-02-12
### Fixed
- Return error when both writing style and tone are provided in the same request

## [1.16.1] - 2025-01-23
### Added
- Fix allowed values for writing styles.

## [1.16.0] - 2025-01-22
### Added
- Added checks for supported languages in the Write API.

## [1.15.3] - 2025-01-17
### Fixed
- Fix BCP-47 conversion for languages without hyphens.
- Accept variant-less target languages for Write (server chooses default variant).

## [1.15.2] - 2025-01-17
### Fixed
- Fix typo in util function that causes a crash.

## [1.15.1] - 2025-01-17
### Fixed
- `v2/write/rephrase` now returns the target language in BCP-47 format,
  like the real API.

## [1.15.0] - 2025-01-15
### Added
- Added support for the Write API in the mock server.

## [1.14.1] - 2025-01-14
### Fixed
- Update `path-to-regexp` dependency due to CVE-2024-52798
- Update `cross-spawn` dependency due to CVE-2024-21538

## [1.14.0] - 2024-11-15
### Added
- `/translate` endpoint: added `model_type` request parameter and
  `model_type_used` response parameter.

## [1.13.0] - 2024-09-13
### Added
- Add supported glossary languages: Danish (`'da'`), Norwegian (bokmål)
  (`'nb'`), and Swedish (`'sv'`).
- Add billed characters to translate-text function: (`show_billed_characters`
  request parameter, and `billed_characters` response parameter).

## [1.12.0] - 2024-04-08
### Added
- Verify keepalive is used by clients by rejecting session reuse on new sockets,
  except in case where no-response mode is active
- Add `mock-server-session-allow-missing-user-agent` session header to override
  missing User-Agent check.
- Add supported glossary languages: Portuguese (`'PT'`), Russian (`'RU'`), and Chinese (`'ZH'`).
- Add `output_format` parameter for document upload, to specify the desired file
  format of the output file
- Add new language Arabic (`'AR'`).

### Security
- Run `npm audit fix` to update dependencies.

## [1.11.0] - 2023-07-06
### Added
- Add formality for Japanese (`'JA'`).
- Add JSON-requests support to certain endpoints, matching DeepL API.

## [1.10.0] - 2023-01-26
### Added
- Add new languages Korean (`'KO'`) and Norwegian (bokmål) (`'NB'`).
- Add limited support for XLIFF files. As this mock server only translates text
  files, XLIFF files will return a 503 error (the same as for other file types).

## [1.9.1] - 2022-12-07
### Fixed
- `formality=default` is allowed for all target languages.

## [1.9.0] - 2022-11-03
### Added
- Add to supported glossary language pairs:
  - English <-> Dutch

## [1.8.1] - 2022-11-03
### Fixed
- Mock server incorrectly supported JSON requests that are not supported by
  DeepL API. Support for JSON requests is removed.
  * [#3](https://github.com/DeepLcom/deepl-mock/issues/3)
    thanks to [DevViktorKovacs](https://github.com/DevViktorKovacs).

## [1.8.0] - 2022-09-26
### Added
- Add `formality` options: `prefer_less` and `prefer_more`

### Fixed
- Glossary language codes are case-insensitive.

## [1.7.0] - 2022-09-09
### Added
- Add to supported glossary language pairs:
  - German <-> French
  - English <-> Italian
  - English <-> Japanese
  - English <-> Polish
- Add new language Ukrainian (`'UK'`).

### Fixed
- Fix bug with missing `target_lang` or `source_lang` in glossary create.

## [1.6.0] - 2022-07-07
### Added
- Add support for glossary creation using CSV format.

### Changed
- Update contributing guidelines, we can now accept Pull Requests.
- Update `package-lock.json`: remove `dicer` 0.3.0 from indirect dependencies.

### Fixed
- Fix an incorrect docker command in the readme.
  * Pull request [#2](https://github.com/DeepLcom/deepl-mock/pull/2)
    thanks to [qyanu](https://github.com/qyanu).

## [1.5.0] - 2022-05-18
### Added
- Add new languages Indonesian (`'ID'`) and Turkish (`'TR''`).

## [1.4.0] - 2022-04-13
### Added
- Add `error_message` field to document status if an error occurs during document translation fails,
  and check if detected source language matches target language. The deprecated `message` field is
  also added to match the live API.

### Changed
- Update name for the target language `zh` to "Chinese (simplified)".

## [1.3.2] - 2022-03-01
### Added
- Add support for `tag_handling=html`.
- `formality` parameter is checked against `target_lang`.

### Changed
- Update `package-lock.json`: upgrade `follow-redirects` to 1.14.9 to silence security warnings.
  Note: security vulnerability [CVE-2022-0536](https://nvd.nist.gov/vuln/detail/CVE-2022-0536)
  affects cross-domain proxying and has no impact here because the proxy server is restricted to
  target only the mock server itself.

### Fixed
- Raise request body size limits to 50 MiB.
- Fix error response message when attempting to download a document before it has been translated.

## [1.3.1] - 2022-01-21
### Added
- Add contribution guidelines -- currently we are unable to accept Pull Requests.

### Changed
- npm start command now uses environment variables if defined for DEEPL_MOCK_SERVER_PORT and
  DEEPL_MOCK_PROXY_SERVER_PORT.
- Update `package-lock.json`: upgrade `follow-redirects` to 1.14.7 to silence security warnings.
  Note: security vulnerability [CVE-2022-0155](https://nvd.nist.gov/vuln/detail/CVE-2022-0155)
  affects cross-domain proxying and has no impact here because the proxy server is restricted to
  target only the mock server itself.

### Fixed
- Remove "localhost" from listen() calls.

## [1.3.0] - 2021-11-15
### Added
- Add glossary support for document translation.
- Add missing argument validation for: formality, split_sentences, preserve_formatting and
  outline_detection.
- Add an optional proxy server that proxies requests to the mock server, listening on port 3001 by
  default.
- Add `expect-proxy` session variable to reject requests not via proxy, as determined by presence of
  the `Forwarded` header.

### Changed
- Require a non-empty `User-Agent` header for all endpoints.

## [1.2.0] - 2021-10-06
### Added
- Add support for `/v2/glossary-languages-pair` endpoint.

### Fixed
- Document status seconds_remaining field is an integer.
- Glossary info source and target languages are lowercase.

## [1.1.0] - 2021-09-13
### Added
- Add support for glossary API functions.

### Fixed
- Accept both query and body parameters for all HTTP methods.
- Refactor internal date usage to use Date objects.

## [1.0.1] - 2021-08-12
### Added
- Add explicit copyright notice to all source files.

## [1.0.0] - 2021-08-12
### Added
- Add support for Authorization header with `DeepL-Auth-Key ` prefix.

### Fixed
- Fix bug in error responses introduced in eslint refactoring.

## [0.2.0] - 2021-08-03
### Added
- Use `eslint` and `airbnb` style for code checking.

### Fixed
- Fix issue when no array parameters are specified.

## [0.1.0] - 2021-07-30
Initial version.

[Unreleased]: https://github.com/DeepLcom/deepl-mock/compare/v1.20.0...HEAD
[1.20.0]: https://github.com/DeepLcom/deepl-mock/compare/v1.19.0...v1.20.0
[1.19.0]: https://github.com/DeepLcom/deepl-mock/compare/v1.18.0...v1.19.0
[1.18.0]: https://github.com/DeepLcom/deepl-mock/compare/v1.17.4...v1.18.0
[1.17.4]: https://github.com/DeepLcom/deepl-mock/compare/v1.17.3...v1.17.4
[1.17.3]: https://github.com/DeepLcom/deepl-mock/compare/v1.17.2...v1.17.3
[1.17.2]: https://github.com/DeepLcom/deepl-mock/compare/v1.17.1...v1.17.2
[1.17.1]: https://github.com/DeepLcom/deepl-mock/compare/v1.17.0...v1.17.1
[1.17.0]: https://github.com/DeepLcom/deepl-mock/compare/v1.16.3...v1.17.0
[1.16.3]: https://github.com/DeepLcom/deepl-mock/compare/v1.16.2...v1.16.3
[1.16.2]: https://github.com/DeepLcom/deepl-mock/compare/v1.16.1...v1.16.2
[1.16.1]: https://github.com/DeepLcom/deepl-mock/compare/v1.16.0...v1.16.1
[1.16.0]: https://github.com/DeepLcom/deepl-mock/compare/v1.15.3...v1.16.0
[1.15.3]: https://github.com/DeepLcom/deepl-mock/compare/v1.15.2...v1.15.3
[1.15.2]: https://github.com/DeepLcom/deepl-mock/compare/v1.15.1...v1.15.2
[1.15.1]: https://github.com/DeepLcom/deepl-mock/compare/v1.15.0...v1.15.1
[1.15.0]: https://github.com/DeepLcom/deepl-mock/compare/v1.14.1...v1.15.0
[1.14.1]: https://github.com/DeepLcom/deepl-mock/compare/v1.14.0...v1.14.1
[1.14.0]: https://github.com/DeepLcom/deepl-mock/compare/v1.13.0...v1.14.0
[1.13.0]: https://github.com/DeepLcom/deepl-mock/compare/v1.12.0...v1.13.0
[1.12.0]: https://github.com/DeepLcom/deepl-mock/compare/v1.11.0...v1.12.0
[1.11.0]: https://github.com/DeepLcom/deepl-mock/compare/v1.10.0...v1.11.0
[1.10.0]: https://github.com/DeepLcom/deepl-mock/compare/v1.9.1...v1.10.0
[1.9.1]: https://github.com/DeepLcom/deepl-mock/compare/v1.9.0...v1.9.1
[1.9.0]: https://github.com/DeepLcom/deepl-mock/compare/v1.8.1...v1.9.0
[1.8.1]: https://github.com/DeepLcom/deepl-mock/compare/v1.8.0...v1.8.1
[1.8.0]: https://github.com/DeepLcom/deepl-mock/compare/v1.7.0...v1.8.0
[1.7.0]: https://github.com/DeepLcom/deepl-mock/compare/v1.6.0...v1.7.0
[1.6.0]: https://github.com/DeepLcom/deepl-mock/compare/v1.5.0...v1.6.0
[1.5.0]: https://github.com/DeepLcom/deepl-mock/compare/v1.4.0...v1.5.0
[1.4.0]: https://github.com/DeepLcom/deepl-mock/compare/v1.3.2...v1.4.0
[1.3.2]: https://github.com/DeepLcom/deepl-mock/compare/v1.3.1...v1.3.2
[1.3.1]: https://github.com/DeepLcom/deepl-mock/compare/v1.3.0...v1.3.1
[1.3.0]: https://github.com/DeepLcom/deepl-mock/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/DeepLcom/deepl-mock/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/DeepLcom/deepl-mock/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/DeepLcom/deepl-mock/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/DeepLcom/deepl-mock/compare/v0.2.0...v1.0.0
[0.2.0]: https://github.com/DeepLcom/deepl-mock/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/DeepLcom/deepl-mock/releases/tag/v0.1.0
