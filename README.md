# DeepL API mock server
A mock server that simulates some behaviour of the
[DeepL API](https://www.deepl.com/docs-api?utm_source=github&utm_medium=github-deepl-mock-readme) to simplify application
testing. In addition, a proxy server is included to test proxy usage.

Note: this server is intended for testing, not for use in production, and it might not receive
regular security updates. 

## Usage

The server listens on two ports: the main port (by default: 3000) imitates the DeepL API, and the
proxy port (by default: 3001) implements a basic proxy server.   

### Using Docker

With Docker, no other software needs to be installed. Build a Docker image using the provided Dockerfile:
```shell
docker image build -t deepl/deepl-mock .
```

Run a Docker container using the image, exposing ports 3000 and 3001:
```shell
docker run -d --rm --name deepl-mock -p3000:3000 -p3001:3001 deepl/deepl-mock
```

If you are executing unit tests of an official DeepL client library (for example
[deepl-python](https://github.com/DeepLcom/deepl-python)
or [deepl-dotnet](https://github.com/DeepLcom/deepl-dotnet)), define the following
environment variables before executing the tests:
```shell
export DEEPL_MOCK_SERVER_PORT=3000
export DEEPL_MOCK_PROXY_SERVER_PORT=3001
export DEEPL_SERVER_URL=http://localhost:3000
export DEEPL_PROXY_URL=http://localhost:3001

# Execute tests -- see the corresponding client library documentation
...
```

When finished, stop the Docker container:
```shell
docker stop deepl-mock
```

### Manually

You can also run the server manually without using Docker. First install
[Node.js](https://nodejs.dev/learn/how-to-install-nodejs), then proceed using `npm`:
```shell
npm install     # Install required packages
npm audit       # Check for security updates
npm start       # Run the mock server
```

By default, the mock server listens on ports 3000 (main API) and 3001 (basic proxy). Define the
**DEEPL_MOCK_SERVER_PORT** and **DEEPL_MOCK_PROXY_SERVER_PORT** environment variables to change this
behaviour:
```shell
export DEEPL_MOCK_SERVER_PORT=4000
export DEEPL_MOCK_PROXY_SERVER_PORT=4001
npm start
```
If you are executing unit tests of an official DeepL client library the **DEEPL_SERVER_URL** and
**DEEPL_PROXY_URL** environment variables should also be updated.

## Spec validation (optional)

Two opt-in flags validate request and response bodies against the DeepL
[OpenAPI spec](https://github.com/DeepLcom/openapi) at runtime. Both default
to off and can be enabled independently:

- **VALIDATE_RESPONSES=1** — validate every response body. Mismatches are
  returned as a 500 with `{ message, errors }` listing the field and the
  specific schema rule that failed, useful for catching mock/spec drift
  during development.
- **VALIDATE_REQUESTS=1** — validate every request body, query and path
  parameter. Mismatches are returned as a 4xx with the same `{ message, errors }`
  shape. Useful for catching SDK request-shape regressions (unknown fields,
  wrong types, missing required params) against any test that hits the mock.

Tests that deliberately send non-spec-conforming bodies (for example, the
`extra_body_parameters` fixtures in client libraries) can bypass request
validation on a per-session basis with `mock-server-session-allow-extra-body: 1`.

The spec is fetched from the public DeepL spec on GitHub at startup. To use a
different source, set exactly one of:

- **DEEPL_MOCK_SPEC_URL** — fetch the spec from this URL
- **DEEPL_MOCK_SPEC_PATH** — read the spec from a local file

Setting both, or failing to load the spec, is a startup error — validation
never silently degrades to off.

```shell
VALIDATE_RESPONSES=1 VALIDATE_REQUESTS=1 npm start
```

The test suite for the spec-validation middleware is a standalone Node
script (it spawns the server on free ports), not a Jest test, so it is not
picked up by `npm test`. Run it explicitly:

```shell
node test/test_response_validation.js
node test/test_request_helpers.js
# Override the base port if 4010-4014 are in use:
TEST_PORT_BASE=5010 node test/test_response_validation.js
```

## Inspecting captured requests

`GET /__session__/last-request` returns the most recent request received in
the session identified by the `mock-server-session` header. The response is a
JSON object with `method`, `path`, `headers`, `query`, and `body`. Use it from
tests to assert what the SDK actually sent on the wire — including parameter
values that the mock does not otherwise reflect back in its response:

```
result = client.translate_text("proton beam", target_lang="DE", model_type="quality_optimized")
captured = http_get("http://localhost:3000/__session__/last-request",
                    headers={"mock-server-session": session_id})
assert captured["body"]["model_type"] == "quality_optimized"
```

Returns 400 if `mock-server-session` is missing, 404 if no request has yet
been captured for that session. The endpoint itself is excluded from capture,
fault injection (`mock-server-session-5xx-count`) and spec validation.

## Server configuration via HTTP-request header
The HTTP-request header **mock-server-session** may be sent with any request, containing a unique string identifying the
test session. A session identifier could be, for example, a test-case name and UUID.

When the server receives an unrecognized session identifier, it creates a new session and uses the session headers
(listed in the table below) to configure the session. These settings affect all requests in that session. Note that
once created, sessions cannot be reconfigured.

The server removes sessions after 10 minutes of inactivity.

| Header field                                 | Type    | Description                                                                                                                                       |
|:---------------------------------------------|:--------|:--------------------------------------------------------------------------------------------------------------------------------------------------|
| mock-server-session                          | Any     | Uniquely identifies this test session.                                                                                                            |
| mock-server-session-no-response-count        | Integer | Specifies the number of requests that should result in no response before resuming normal behavior.                                               |
| mock-server-session-429-count                | Integer | Specifies the number of **/translate** requests that should result in a **429 Too Many Requests** response before resuming normal behavior.       |
| mock-server-session-5xx-count                | Integer | Specifies the number of requests (any endpoint) that should respond with a 5xx status before resuming normal behavior.                            |
| mock-server-session-5xx-status               | Integer | Status code returned by the 5xx fault injection. Must be in 500–599. Default: 503.                                                                |
| mock-server-session-doc-failure              | Integer | Specifies the number of documents that should fail during translation before resuming normal behavior.                                            |
| mock-server-session-init-character-limit     | Integer | Specifies the character limit for user accounts created in this session, specify 0 to remove limit. Default: 20000000.                            |
| mock-server-session-init-document-limit      | Integer | Specifies the document limit for user accounts created in this session, specify 0 to remove limit. Default: 10000.                                |
| mock-server-session-init-team-document-limit | Integer | Specifies the team document limit for user accounts created in this session. Default: no limit.                                                   |
| mock-server-session-doc-queue-time           | Integer | Specifies the time in milliseconds that documents are queued before being translated.                                                             |
| mock-server-session-doc-translate-time       | Integer | Specifies the time in milliseconds that documents take to translate.                                                                              |
| mock-server-session-tm-job-processing-polls  | Integer | Number of polls a translation memory import/export job reports a non-terminal status before completing. Default: 0, so jobs complete on the first poll. Note that an uploaded import reports `awaiting_input`, not `processing`, matching the live API, which detects the upload asynchronously — clients must poll through that status rather than treating it as terminal. |
| mock-server-session-expect-proxy             | Integer | If non-zero, only requests via the proxy server are accepted. Requests are considered to come via proxy if the Forwarded HTTP header is included. |
| mock-server-session-allow-reconnections      | Integer | If non-zero, disables rejecting requests due to unnecessary reconnections.                                                                        |
| mock-server-session-allow-missing-user-agent | Integer | If non-zero, disables rejecting requests due to missing User-Agent.                                                                               |
| mock-server-session-allow-extra-body         | Integer | If non-zero, bypasses opt-in request validation (`VALIDATE_REQUESTS=1`) for this session's requests. Use for tests that deliberately send non-spec-conforming bodies. |

## Limitations compared with the DeepL API
### Limited translation
The real DeepL API can accurately translate arbitrary text, however this mock server can only translate the test
phrase "proton beam" among the DeepL-supported languages, and multi-line text where each line contains the phrase
"proton beam". The translation functions will check the desired target language and respond with the corresponding
translation of "proton beam", regardless of the input text. 

Additionally, this mock server cannot auto-detect the source language, unless it matches one of the test phrase
translations. Otherwise, the source language is assumed to be English.

### Simplified glossaries
This mock server implements glossaries and translations using glossaries, but translations will only
make use of glossary terms if the whole input text (or each line in a document) *exactly* matches a
glossary term. In contrast, the real DeepL API uses sentence context and language grammar when
applying glossary terms.

### User accounts
This server creates a new user account whenever it receives a request with an unrecognized **auth_key**. To test
behaviour due to an incorrect key use either an empty key, or the value "invalid". The server removes user accounts
after 10 minutes of inactivity.

### Only .txt and .htm/.html files
This mock server only supports .txt and .htm/.html files for document translation. The DeepL API additionally supports
.docx, .pptx, .pdf, .html/.htm, .xlf/.xliff, and .xlsx files. The server removes documents after 10 minutes of inactivity.

### Account usage
This mock server uses simplified calculations to update account usage. 

### Formality, tag-handling, formatting 
This mock server does not implement these features, however the API input parameters are validated.

### Model types
This mock server allows the quality-optimized models for all language pairs,
unlike the real DeepL API (which supports a subset of language pairs). Note that
as this mock server does not implement translation, the model type used has no
impact.

### Billing period and usage limitations

This mock server always uses a fixed billing period for all accounts, beginning at 04:05:06.789 am on the 3rd day of the current month and ending at the same time on the 3rd day of the next month (UTC). Individual API key character counts are not tracked; all usage is simulated and does not reflect real consumption per key.

## Additional checks compared with the DeepL API

### User-Agent

This mock server rejects requests that do not include a non-empty `User-Agent` header, while the DeepL API accepts them.
To disable this check, set the `mock-server-session-allow-missing-user-agent` session header to non-zero.

### Socket reconnections

To check that clients use `Keep-Alive` correctly, this mock server detects when a new socket is used for an
existing session and rejects these requests. Clients correctly using `Keep-Alive` should avoid these rejections.
To disable this check, set the `mock-server-session-allow-reconnections` session header to non-zero.

## Issues
If you experience problems using the library, or would like to request a new feature, please open an
[issue][issues]. 

## Development

We welcome Pull Requests, please read the [contributing guidelines](CONTRIBUTING.md).

[issues]: https://www.github.com/DeepLcom/deepl-mock/issues
