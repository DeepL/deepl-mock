// Copyright 2026 DeepL SE (https://www.deepl.com)
// Use of this source code is governed by an MIT
// license that can be found in the LICENSE file.
//
// Tests for v3 translation memory management behaviour.

const translationMemories = require('../translationMemories');

const BASE_URL = 'http://localhost:3000';

function importedTranslationMemory(authKey, displayName = 'Imported TM') {
  const job = translationMemories.createImportJob(
    authKey,
    BASE_URL,
    { file_name: 'legal.tmx', content_length: 1024 },
    displayName,
  );
  translationMemories.completeImportUpload(job.job_id);
  const completed = translationMemories.getJobInfo(job.job_id, authKey);
  return { jobId: job.job_id, result: completed.results[0] };
}

describe('getTranslationMemorySegments', () => {
  const authKey = 'tm-segments-key';

  it('pages through segments with an opaque cursor', () => {
    const first = translationMemories.getTranslationMemorySegments(
      translationMemories.DEFAULT_TM_ID,
      authKey,
      { pageSize: 5 },
    );

    expect(first.segments).toHaveLength(5);
    expect(first.segment_count).toBe(12);
    expect(first.next_page_cursor).toBeDefined();

    const second = translationMemories.getTranslationMemorySegments(
      translationMemories.DEFAULT_TM_ID,
      authKey,
      { pageSize: 5, pageCursor: first.next_page_cursor },
    );
    expect(second.segments).toHaveLength(5);
    expect(second.segments[0].source_segment_id)
      .not.toBe(first.segments[0].source_segment_id);

    const last = translationMemories.getTranslationMemorySegments(
      translationMemories.DEFAULT_TM_ID,
      authKey,
      { pageSize: 5, pageCursor: second.next_page_cursor },
    );
    expect(last.segments).toHaveLength(2);
    expect(last.next_page_cursor).toBeUndefined();
  });

  it('filters by text without changing the TM-level segment count', () => {
    const filtered = translationMemories.getTranslationMemorySegments(
      translationMemories.DEFAULT_TM_ID,
      authKey,
      { pageSize: 50, filterText: 'Nummer 7' },
    );

    expect(filtered.segments).toHaveLength(1);
    expect(filtered.segment_count).toBe(12);
  });

  it('honours filter_case_sensitive', () => {
    const insensitive = translationMemories.getTranslationMemorySegments(
      translationMemories.DEFAULT_TM_ID,
      authKey,
      { pageSize: 50, filterText: 'quelltext' },
    );
    expect(insensitive.segments.length).toBeGreaterThan(0);

    const sensitive = translationMemories.getTranslationMemorySegments(
      translationMemories.DEFAULT_TM_ID,
      authKey,
      { pageSize: 50, filterText: 'quelltext', filterCaseSensitive: true },
    );
    expect(sensitive.segments).toHaveLength(0);
  });

  it('rejects a filter shorter than two characters', () => {
    expect(() => translationMemories.getTranslationMemorySegments(
      translationMemories.DEFAULT_TM_ID,
      authKey,
      { pageSize: 50, filterText: 'a' },
    )).toThrow(/filter_text/);
  });
});

describe('import jobs', () => {
  it('reports awaiting_input until the file is uploaded', () => {
    const authKey = 'tm-import-key';
    const created = translationMemories.createImportJob(
      authKey,
      BASE_URL,
      { file_name: 'legal.tmx', content_length: 1024 },
      'Legal TM',
    );

    expect(created.upload_url).toContain(created.job_id);

    const pending = translationMemories.getJobInfo(created.job_id, authKey);
    expect(pending.operation).toBe('import');
    expect(pending.product).toBe('translation_memory');
    expect(pending.results[0].status).toBe('awaiting_input');
    expect(pending.results[0].status_metadata.required_action).toBe('Waiting for upload');
  });

  it('keeps reporting awaiting_input after the upload, never processing', () => {
    // The live API detects the upload asynchronously, so the job stays awaiting_input for a
    // while and then goes straight to completed. A mock that reported processing here would
    // teach client libraries the wrong lesson, which is exactly how a real bug shipped.
    const authKey = 'tm-import-awaiting-key';
    const job = translationMemories.createImportJob(
      authKey,
      BASE_URL,
      { file_name: 'legal.tmx', content_length: 1024 },
      'Awaiting TM',
      2,
    );
    translationMemories.completeImportUpload(job.job_id);

    const statuses = [
      translationMemories.getJobInfo(job.job_id, authKey).results[0].status,
      translationMemories.getJobInfo(job.job_id, authKey).results[0].status,
      translationMemories.getJobInfo(job.job_id, authKey).results[0].status,
    ];

    expect(statuses).toEqual(['awaiting_input', 'awaiting_input', 'completed']);
    expect(statuses).not.toContain('processing');
  });

  it('omits segment timestamps the live API does not return', () => {
    const page = translationMemories.getTranslationMemorySegments(
      translationMemories.DEFAULT_TM_ID,
      'tm-timestamps-key',
      { pageSize: 3 },
    );

    // creation_time/updated_time are never returned by the live API; last_used_time only for
    // segments that have been used.
    page.segments.forEach((segment) => {
      expect(segment).not.toHaveProperty('creation_time');
      expect(segment).not.toHaveProperty('updated_time');
      segment.targets.forEach((target) => {
        expect(target).not.toHaveProperty('creation_time');
        expect(target).not.toHaveProperty('updated_time');
      });
    });
    expect(page.segments[0]).toHaveProperty('last_used_time');
    expect(page.segments[1]).not.toHaveProperty('last_used_time');
  });

  it('creates a translation memory once the upload completes', () => {
    const authKey = 'tm-import-complete-key';
    const { result } = importedTranslationMemory(authKey, 'Legal TM');

    expect(result.status).toBe('completed');
    expect(result.skipped_segment_count).toBe(0);

    const tm = translationMemories.getTranslationMemoryInfo(result.translation_memory_id, authKey);
    expect(tm.name).toBe('Legal TM');
  });

  it('rejects a declared file without a name or with a non-positive length', () => {
    const authKey = 'tm-import-invalid-key';
    expect(() => translationMemories.createImportJob(
      authKey,
      BASE_URL,
      { content_length: 1024 },
    )).toThrow(/file_name/);
    expect(() => translationMemories.createImportJob(
      authKey,
      BASE_URL,
      { file_name: 'legal.tmx', content_length: 0 },
    )).toThrow(/content_length/);
  });
});

describe('export jobs', () => {
  it('completes on the first poll and serves the TMX document', () => {
    const authKey = 'tm-export-key';
    const created = translationMemories.createExportJob(
      translationMemories.DEFAULT_TM_ID,
      authKey,
      BASE_URL,
    );
    expect(created.reusedExisting).toBe(false);

    const jobId = created.body.job_id;
    const completed = translationMemories.getJobInfo(jobId, authKey);
    expect(completed.results[0].status).toBe('completed');
    expect(completed.results[0].download_url).toContain(jobId);

    expect(translationMemories.getExportContent(jobId)).toContain('<tmx version="1.4">');
  });

  it('reports processing for as many polls as the session requests', () => {
    const authKey = 'tm-export-processing-key';
    const created = translationMemories.createExportJob(
      translationMemories.DEFAULT_TM_ID,
      authKey,
      BASE_URL,
      2,
    );

    const jobId = created.body.job_id;
    expect(translationMemories.getJobInfo(jobId, authKey).results[0].status).toBe('processing');
    expect(translationMemories.getJobInfo(jobId, authKey).results[0].status).toBe('processing');
    expect(translationMemories.getJobInfo(jobId, authKey).results[0].status).toBe('completed');
  });

  it('reuses a completed export for the same translation memory', () => {
    const authKey = 'tm-export-reuse-key';
    const first = translationMemories.createExportJob(
      translationMemories.DEFAULT_TM_ID,
      authKey,
      BASE_URL,
    );
    translationMemories.getJobInfo(first.body.job_id, authKey);

    const second = translationMemories.createExportJob(
      translationMemories.DEFAULT_TM_ID,
      authKey,
      BASE_URL,
    );
    expect(second.reusedExisting).toBe(true);
    expect(second.body.job_id).toBe(first.body.job_id);
  });
});

describe('removeTranslationMemory', () => {
  it('hides the shared default translation memory per auth key', () => {
    const authKey = 'tm-delete-default-key';
    const otherKey = 'tm-delete-other-key';

    translationMemories.removeTranslationMemory(translationMemories.DEFAULT_TM_ID, authKey);

    expect(() => translationMemories.getTranslationMemory(
      translationMemories.DEFAULT_TM_ID,
      authKey,
    )).toThrow();
    expect(translationMemories.getTranslationMemoryInfoList(authKey, 0, 10).total_count).toBe(0);

    // Unaffected for every other caller.
    expect(translationMemories.getTranslationMemoryInfo(
      translationMemories.DEFAULT_TM_ID,
      otherKey,
    ).name).toBe('Default Translation Memory');
  });

  it('deletes an imported translation memory', () => {
    const authKey = 'tm-delete-imported-key';
    const { result } = importedTranslationMemory(authKey);

    translationMemories.removeTranslationMemory(result.translation_memory_id, authKey);

    expect(() => translationMemories.getTranslationMemory(
      result.translation_memory_id,
      authKey,
    )).toThrow();
  });
});

describe('job ownership', () => {
  it('does not expose a job to another auth key', () => {
    const authKey = 'tm-job-owner-key';
    const created = translationMemories.createExportJob(
      translationMemories.DEFAULT_TM_ID,
      authKey,
      BASE_URL,
    );

    expect(() => translationMemories.getJobInfo(created.body.job_id, 'tm-job-intruder-key'))
      .toThrow();
  });
});
