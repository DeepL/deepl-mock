// Copyright 2025 DeepL SE (https://www.deepl.com)
// Use of this source code is governed by an MIT
// license that can be found in the LICENSE file.

const { randomUUID } = require('node:crypto');
const util = require('./util');

const translationMemories = new Map();
const DEFAULT_TM_ID = 'a74d88fb-ed2a-4943-a664-a4512398b994';
const DEFAULT_TM_SEGMENT_COUNT = 12;

// Import and export jobs, keyed by job ID. Both operations share one map
// because the API exposes them through a single GET /jobs/{job_id} endpoint.
const jobs = new Map();

// Most recent completed export job per auth key and translation memory, used to
// emulate the real API's export reuse (a repeated export of an unchanged TM
// answers 200 with the existing job instead of 202 with a new one). The key
// includes the auth key because the default TM is shared across callers, so
// keying by TM alone would let one caller clobber another's entry.
const exportJobsByTm = new Map();

function exportJobKey(authKey, tmId) {
  return `${authKey}:${tmId}`;
}

// The default translation memory is shared by every auth key, so deleting it
// is tracked per auth key rather than by removing it from the map.
const deletedDefaultTms = new Set();

util.scheduleCleanup(translationMemories, (tm, tmId) => {
  console.log(`Removing translation memory "${tm.name}" (${tmId})`);
});
util.scheduleCleanup(jobs, (job, jobId) => {
  console.log(`Removing translation memory ${job.operation} job (${jobId})`);
});

/**
 * Builds a deterministic set of segments, so tests can rely on stable source
 * and target texts across runs.
 *
 * Segment timestamps match the live API, which never returns created_time or
 * updated_time on a segment and returns last_used_time only for segments that
 * have actually been used. Every third segment therefore carries last_used_time
 * and the rest carry no timestamps at all, so client libraries are exercised on
 * both the present and the absent case.
 */
function generateSegments(tmId, count, sourceLanguage, targetLanguages) {
  const lastUsed = new Date(0);
  return Array.from({ length: count }, (_, index) => {
    const used = index % 3 === 0;
    return {
      sourceSegmentId: `${tmId}-source-${index}`,
      sourceText: `Quelltext Nummer ${index}`,
      lastUsedTime: used ? lastUsed : undefined,
      targets: targetLanguages.map((targetLanguage) => ({
        targetSegmentId: `${tmId}-target-${targetLanguage}-${index}`,
        targetLanguage,
        targetText: `Target text number ${index} (${sourceLanguage}->${targetLanguage})`,
        lastUsedTime: used ? lastUsed : undefined,
      })),
    };
  });
}

function getDefaultTranslationMemory() {
  const sourceLanguage = 'de';
  const targetLanguages = ['en', 'es', 'fr'];
  return {
    translationMemoryId: DEFAULT_TM_ID,
    name: 'Default Translation Memory',
    sourceLanguage,
    targetLanguages,
    segmentCount: DEFAULT_TM_SEGMENT_COUNT,
    creationTime: new Date(0),
    updatedTime: new Date(0),
    segments: generateSegments(
      DEFAULT_TM_ID,
      DEFAULT_TM_SEGMENT_COUNT,
      sourceLanguage,
      targetLanguages,
    ),
    used: new Date(),
    authKey: null, // Available to all users
  };
}

function extractTranslationMemoryInfo(tm) {
  return {
    translation_memory_id: tm.translationMemoryId,
    name: tm.name,
    source_language: tm.sourceLanguage,
    target_languages: tm.targetLanguages,
    segment_count: tm.segmentCount,
    creation_time: tm.creationTime.toISOString(),
    updated_time: tm.updatedTime.toISOString(),
  };
}

// Adds a timestamp key only when the value is present, matching the live API,
// which omits absent timestamps rather than sending nulls.
function withTimestamps(target, segment) {
  const result = target;
  if (segment.createdTime) result.created_time = segment.createdTime.toISOString();
  if (segment.updatedTime) result.updated_time = segment.updatedTime.toISOString();
  if (segment.lastUsedTime) result.last_used_time = segment.lastUsedTime.toISOString();
  return result;
}

function extractSegment(segment) {
  return withTimestamps({
    source_segment_id: segment.sourceSegmentId,
    source_text: segment.sourceText,
    targets: segment.targets.map((target) => withTimestamps({
      target_segment_id: target.targetSegmentId,
      target_language: target.targetLanguage,
      target_text: target.targetText,
    }, target)),
  }, segment);
}

function isValidTranslationMemoryId(tmId) {
  return util.isValidUuid(tmId);
}

function getTranslationMemory(tmId, authKey) {
  if (tmId === DEFAULT_TM_ID && !deletedDefaultTms.has(authKey)) {
    return getDefaultTranslationMemory();
  }
  const tm = translationMemories.get(tmId);
  if (tm?.authKey === authKey) {
    tm.used = new Date();
    return tm;
  }
  throw new util.HttpError('not found', 404);
}

function getTranslationMemoryInfo(tmId, authKey) {
  return extractTranslationMemoryInfo(getTranslationMemory(tmId, authKey));
}

function getTranslationMemoryInfoList(authKey, page, pageSize) {
  const result = [];
  // eslint-disable-next-line no-restricted-syntax
  for (const [, tm] of translationMemories.entries()) {
    if (tm.authKey === authKey) {
      result.push(extractTranslationMemoryInfo(tm));
    }
  }
  if (!deletedDefaultTms.has(authKey)) {
    const defaultTm = getDefaultTranslationMemory();
    result.push(extractTranslationMemoryInfo(defaultTm));
  }

  // Apply pagination
  const startIndex = page * pageSize;
  const endIndex = startIndex + pageSize;
  const paginatedResult = result.slice(startIndex, endIndex);

  return {
    translation_memories: paginatedResult,
    total_count: result.length,
  };
}

function encodeCursor(offset) {
  return Buffer.from(String(offset), 'utf8').toString('base64url');
}

function decodeCursor(cursor) {
  const offset = Number.parseInt(Buffer.from(cursor, 'base64url').toString('utf8'), 10);
  if (Number.isNaN(offset) || offset < 0) {
    throw new util.HttpError('Invalid page_cursor', 400);
  }
  return offset;
}

/**
 * Returns one page of segments. Pagination is cursor-based: the caller omits
 * page_cursor on the first call, then passes back next_page_cursor until it is
 * absent. segment_count is TM-level and deliberately unaffected by filterText.
 */
function getTranslationMemorySegments(tmId, authKey, {
  pageSize, pageCursor, filterText, filterCaseSensitive,
}) {
  const tm = getTranslationMemory(tmId, authKey);

  if (filterText !== undefined && filterText !== '' && filterText.length < 2) {
    throw new util.HttpError('Parameter "filter_text" must be at least 2 characters', 400);
  }

  let segments = tm.segments || [];
  if (filterText) {
    const needle = filterCaseSensitive ? filterText : filterText.toLowerCase();
    const matches = (text) => (filterCaseSensitive ? text : text.toLowerCase()).includes(needle);
    segments = segments.filter(
      (segment) => matches(segment.sourceText)
        || segment.targets.some((target) => matches(target.targetText)),
    );
  }

  const offset = pageCursor ? decodeCursor(pageCursor) : 0;
  const page = segments.slice(offset, offset + pageSize);
  const nextOffset = offset + page.length;

  const response = {
    segments: page.map(extractSegment),
    segment_count: tm.segmentCount,
  };
  if (nextOffset < segments.length) {
    response.next_page_cursor = encodeCursor(nextOffset);
  }
  return response;
}

function removeTranslationMemory(tmId, authKey) {
  const tm = getTranslationMemory(tmId, authKey);
  console.log(`Removing translation memory "${tm.name}" (${tmId})`);
  if (tmId === DEFAULT_TM_ID) {
    // Shared across auth keys: hide it from this caller instead of deleting it.
    deletedDefaultTms.add(authKey);
  } else {
    translationMemories.delete(tmId);
  }
  exportJobsByTm.delete(exportJobKey(authKey, tmId));
  console.log('Done');
}

function extractJobInfo(job) {
  const result = { status: job.status };
  if (job.status === 'awaiting_input') {
    result.status_metadata = { required_action: 'Waiting for upload' };
  }
  if (job.error) {
    result.error = { message: job.error };
  }

  const info = {
    job_id: job.jobId,
    product: 'translation_memory',
    operation: job.operation,
    created_at: job.createdAt.toISOString(),
    updated_at: job.updatedAt.toISOString(),
    parameters: {},
    results: [result],
  };

  if (job.operation === 'import') {
    info.parameters.display_name = job.displayName;
    info.source_file = {
      content_type: job.sourceFile.contentType,
      content_length: job.sourceFile.contentLength,
    };
    if (job.status === 'completed') {
      result.translation_memory_id = job.translationMemoryId;
      result.skipped_segment_count = job.skippedSegmentCount;
    }
  } else {
    info.parameters.translation_memory_id = job.translationMemoryId;
    if (job.downloadUrl) {
      result.download_url = job.downloadUrl;
      result.expires_at = job.expiresAt.toISOString();
    }
  }

  return info;
}

/**
 * Creates an import job. The caller uploads the TMX file to the returned URL;
 * the mock only records the declared metadata, it never parses the file.
 */
function createImportJob(authKey, baseUrl, sourceFile, displayName, processingPolls = 0) {
  if (!sourceFile || !sourceFile.file_name) {
    throw new util.HttpError("Parameter 'source_file.file_name' is required.", 400);
  }
  const contentLength = Number(sourceFile.content_length);
  if (!Number.isInteger(contentLength) || contentLength <= 0) {
    throw new util.HttpError("Parameter 'source_file.content_length' must be greater than 0.", 400);
  }

  const jobId = randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 3600 * 1000);
  const job = {
    jobId,
    authKey,
    operation: 'import',
    status: 'awaiting_input',
    createdAt: now,
    updatedAt: now,
    used: now,
    displayName: displayName || sourceFile.file_name,
    sourceFile: {
      fileName: sourceFile.file_name,
      contentType: sourceFile.content_type || 'application/xml',
      contentLength,
    },
    uploadUrl: `${baseUrl}/__upload__/translation_memories/${jobId}`,
    expiresAt,
    remainingProcessingPolls: processingPolls,
  };
  jobs.set(jobId, job);
  console.log(`Created translation memory import job (${jobId})`);

  return {
    job_id: jobId,
    upload_url: job.uploadUrl,
    expires_at: expiresAt.toISOString(),
  };
}

/**
 * Completes the upload half of an import job. Called by the mock-only upload
 * endpoint that stands in for the Asset Store; no auth key is available there,
 * the job ID in the URL is the capability.
 */
function completeImportUpload(jobId) {
  const job = jobs.get(jobId);
  if (!job || job.operation !== 'import') {
    throw new util.HttpError('not found', 404);
  }
  if (job.status !== 'awaiting_input') {
    throw new util.HttpError('Upload already completed', 409);
  }

  const tmId = randomUUID();
  const now = new Date();
  const sourceLanguage = 'de';
  const targetLanguages = ['en'];
  const segmentCount = 3;
  translationMemories.set(tmId, {
    translationMemoryId: tmId,
    name: job.displayName,
    sourceLanguage,
    targetLanguages,
    segmentCount,
    creationTime: now,
    updatedTime: now,
    segments: generateSegments(tmId, segmentCount, sourceLanguage, targetLanguages),
    used: now,
    authKey: job.authKey,
  });

  // The status deliberately stays "awaiting_input": the live API detects the upload
  // asynchronously and keeps reporting awaiting_input for a while afterwards (~30s
  // observed in production), then goes straight to completed without ever reporting
  // processing. Clients must therefore keep polling through awaiting_input.
  job.uploaded = true;
  job.translationMemoryId = tmId;
  job.skippedSegmentCount = 0;
  job.updatedAt = now;
  job.used = now;
  console.log(`Uploaded translation memory import job (${jobId}), created TM ${tmId}`);
}

/**
 * Creates an export job, or reuses the completed job from a previous export of
 * the same translation memory. The boolean in the result tells the caller
 * whether to answer 200 (reused) or 202 (newly created).
 */
function createExportJob(tmId, authKey, baseUrl, processingPolls = 0) {
  getTranslationMemory(tmId, authKey);

  const existingJobId = exportJobsByTm.get(exportJobKey(authKey, tmId));
  const existingJob = existingJobId ? jobs.get(existingJobId) : undefined;
  if (existingJob && existingJob.authKey === authKey && existingJob.status === 'completed') {
    existingJob.used = new Date();
    return {
      reusedExisting: true,
      body: {
        job_id: existingJob.jobId,
        parameters: { translation_memory_id: tmId },
      },
    };
  }

  const jobId = randomUUID();
  const now = new Date();
  jobs.set(jobId, {
    jobId,
    authKey,
    operation: 'export',
    status: 'processing',
    createdAt: now,
    updatedAt: now,
    used: now,
    translationMemoryId: tmId,
    baseUrl,
    remainingProcessingPolls: processingPolls,
  });
  console.log(`Created translation memory export job (${jobId}) for TM ${tmId}`);

  return {
    reusedExisting: false,
    body: {
      job_id: jobId,
      parameters: { translation_memory_id: tmId },
    },
  };
}

/**
 * Returns the status of an import or export job. Jobs complete on the first
 * poll, mirroring documents, which are ready immediately unless a test asks
 * otherwise. A session's tm_job_processing_polls makes the job report
 * "processing" that many times first, so polling loops can be exercised.
 */
function getJobInfo(jobId, authKey) {
  const job = jobs.get(jobId);
  if (!job || job.authKey !== authKey) {
    throw new util.HttpError('not found', 404);
  }
  job.used = new Date();

  // An import is pending once its file has been uploaded; an export is pending from
  // creation. Either way the job reports a non-terminal status for the configured
  // number of polls before completing, so clients exercise their polling loops.
  const pending = job.status === 'processing' || (job.status === 'awaiting_input' && job.uploaded);
  if (pending) {
    if (job.remainingProcessingPolls > 0) {
      job.remainingProcessingPolls -= 1;
    } else {
      job.status = 'completed';
      job.updatedAt = new Date();
      if (job.operation === 'export') {
        job.downloadUrl = `${job.baseUrl}/__download__/translation_memories/${jobId}`;
        job.expiresAt = new Date(job.updatedAt.getTime() + 3600 * 1000);
        // Recorded on completion, not creation, so reuse always points at a job that has
        // actually finished.
        exportJobsByTm.set(exportJobKey(job.authKey, job.translationMemoryId), jobId);
      }
    }
  }

  return extractJobInfo(job);
}

/**
 * Returns the TMX document for a completed export job. Served by the mock-only
 * download endpoint standing in for the Asset Store, so there is no auth key.
 */
function getExportContent(jobId) {
  const job = jobs.get(jobId);
  if (!job || job.operation !== 'export' || job.status !== 'completed') {
    throw new util.HttpError('not found', 404);
  }
  const tm = translationMemories.get(job.translationMemoryId)
    || (job.translationMemoryId === DEFAULT_TM_ID ? getDefaultTranslationMemory() : undefined);
  if (!tm) {
    throw new util.HttpError('not found', 404);
  }

  const units = (tm.segments || []).map((segment) => {
    const tuvs = [
      `      <tuv xml:lang="${tm.sourceLanguage}"><seg>${segment.sourceText}</seg></tuv>`,
      ...segment.targets.map(
        (target) => `      <tuv xml:lang="${target.targetLanguage}"><seg>${target.targetText}</seg></tuv>`,
      ),
    ];
    return `    <tu>\n${tuvs.join('\n')}\n    </tu>`;
  });

  return `<?xml version="1.0" encoding="UTF-8"?>
<tmx version="1.4">
  <header creationtool="deepl-mock" srclang="${tm.sourceLanguage}" segtype="sentence" adminlang="en" datatype="plaintext" o-tmf="TMX"/>
  <body>
${units.join('\n')}
  </body>
</tmx>
`;
}

module.exports = {
  isValidTranslationMemoryId,
  getTranslationMemory,
  getTranslationMemoryInfo,
  getTranslationMemoryInfoList,
  getTranslationMemorySegments,
  removeTranslationMemory,
  extractTranslationMemoryInfo,
  createImportJob,
  completeImportUpload,
  createExportJob,
  getJobInfo,
  getExportContent,
  getDefaultTranslationMemory,
  DEFAULT_TM_ID,
};
