// Copyright 2022 DeepL SE (https://www.deepl.com)
// Use of this source code is governed by an MIT
// license that can be found in the LICENSE file.

const util = require('./util');

const sessions = new Map();
util.scheduleCleanup(sessions, (_, id) => {
  console.debug('Removed session:', id);
});

function createSession(headers, socket) {
  const session = { sockets: [socket] };

  const vars = {
    no_response_count: 'mock-server-session-no-response-count',
    respond_429_count: 'mock-server-session-429-count',
    respond_5xx_count: 'mock-server-session-5xx-count',
    respond_5xx_status: 'mock-server-session-5xx-status',
    doc_failure: 'mock-server-session-doc-failure',
    init_char_limit: 'mock-server-session-init-character-limit',
    init_doc_limit: 'mock-server-session-init-document-limit',
    init_team_doc_limit: 'mock-server-session-init-team-document-limit',
    doc_queue_time: 'mock-server-session-doc-queue-time',
    doc_translate_time: 'mock-server-session-doc-translate-time',
    // Number of polls a translation memory import/export job reports a
    // non-terminal status before completing — "awaiting_input" for an uploaded
    // import (matching the live API, which detects the upload asynchronously),
    // "processing" for an export. Defaults to 0, so jobs complete on the first
    // poll unless a test wants to exercise its polling loop.
    tm_job_processing_polls: 'mock-server-session-tm-job-processing-polls',
    expect_proxy: 'mock-server-session-expect-proxy',
    allow_missing_user_agent: 'mock-server-session-allow-missing-user-agent',
    allow_reconnections: 'mock-server-session-allow-reconnections',
    allow_extra_body: 'mock-server-session-allow-extra-body',
  };

  // eslint-disable-next-line guard-for-in,no-restricted-syntax
  for (const varName in vars) {
    const headerName = vars[varName];
    if (headers[headerName] !== undefined) {
      const value = Number(headers[headerName]);
      if (Number.isNaN(value)) {
        console.error(`Invalid value for header '${headerName}', expected number.`);
      } else {
        session[varName] = value;
        console.debug(`Session header '${headerName}' = ${value}.`);
      }
    }
  }

  session.remaining_no_response_count = session.no_response_count ?? 0;

  return session;
}

module.exports = () => (req, res, next) => {
  // Middleware function applied to all incoming requests
  // Check for "mock-server-session" header. When a new UUID is found, create a new session based on
  // the "mock-server-session-" headers. If an existing UUID is found, the session is not modified.
  // The found session is attached to the request as req.session.
  const uuid = req.headers['mock-server-session'];
  if (uuid) {
    if (!sessions.has(uuid)) {
      sessions.set(uuid, createSession(req.headers, req.socket));
    }

    req.session = sessions.get(uuid);
    req.session.used = new Date();

    if (req.session.sockets.includes(req.socket)) {
      console.info('Socket already used in session');
    } else if (req.session.allow_reconnections !== 0) {
      req.session.sockets.push(req.socket);
    } else if (req.session.no_response_count > 0) {
      // Note: in no-response test cases, clients are expected to open new connections
      req.session.sockets.push(req.socket);
    } else {
      console.error('Socket new for this session');
      res.status(400).send({ message: 'New socket opened in same session.' });
      return undefined; // Do not continue with next handler
    }
  } else {
    req.session = {};
  }

  if (req.session.remaining_no_response_count > 0) {
    req.session.remaining_no_response_count -= 1;
    return undefined; // Give no response and do not continue with next handler
  }

  if (req.session.expect_proxy) {
    if (req.headers.forwarded === undefined) {
      console.error('Expected a request via proxy.');
      res.status(400).send({ message: 'Expected a request via proxy.' });
      return undefined; // Do not continue with next handler
    }
  }

  return next();
};
