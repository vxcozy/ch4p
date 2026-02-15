import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { captureFileState } from './snapshot-utils.js';

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let testDir: string;

beforeEach(async () => {
  testDir = join(tmpdir(), `ch4p-snapshot-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(testDir, { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// captureFileState
// ---------------------------------------------------------------------------

describe('captureFileState()', () => {
  it('captures state of an existing file', async () => {
    const filePath = join(testDir, 'test.txt');
    await writeFile(filePath, 'hello world\nsecond line\n', 'utf-8');

    const snapshot = await captureFileState(filePath);

    expect(snapshot.timestamp).toBeDefined();
    expect(snapshot.state.path).toBe(filePath);
    expect(snapshot.state.exists).toBe(true);
    expect(snapshot.state.isFile).toBe(true);
    expect(snapshot.state.size).toBe(24);
    expect(snapshot.state.lineCount).toBe(3); // 'hello world\nsecond line\n' → 3 lines
    expect(snapshot.state.contentHash).toMatch(/^[a-f0-9]{16}$/);
    expect(snapshot.state.mtime).toBeDefined();
  });

  it('captures state for a non-existent file', async () => {
    const filePath = join(testDir, 'does-not-exist.txt');

    const snapshot = await captureFileState(filePath);

    expect(snapshot.state.path).toBe(filePath);
    expect(snapshot.state.exists).toBe(false);
    expect(snapshot.description).toContain('does not exist');
  });

  it('captures state for a directory (not a file)', async () => {
    const dirPath = join(testDir, 'subdir');
    await mkdir(dirPath);

    const snapshot = await captureFileState(dirPath);

    expect(snapshot.state.exists).toBe(true);
    expect(snapshot.state.isFile).toBe(false);
    expect(snapshot.state.isDirectory).toBe(true);
  });

  it('captures an empty file correctly', async () => {
    const filePath = join(testDir, 'empty.txt');
    await writeFile(filePath, '', 'utf-8');

    const snapshot = await captureFileState(filePath);

    expect(snapshot.state.exists).toBe(true);
    expect(snapshot.state.isFile).toBe(true);
    expect(snapshot.state.size).toBe(0);
    expect(snapshot.state.lineCount).toBe(1); // empty string split('\n') → [''] → length 1
    expect(snapshot.state.contentHash).toMatch(/^[a-f0-9]{16}$/);
  });

  it('produces different hashes for different content', async () => {
    const file1 = join(testDir, 'a.txt');
    const file2 = join(testDir, 'b.txt');
    await writeFile(file1, 'content A', 'utf-8');
    await writeFile(file2, 'content B', 'utf-8');

    const snap1 = await captureFileState(file1);
    const snap2 = await captureFileState(file2);

    expect(snap1.state.contentHash).not.toBe(snap2.state.contentHash);
  });

  it('produces same hash for same content', async () => {
    const file1 = join(testDir, 'x.txt');
    const file2 = join(testDir, 'y.txt');
    await writeFile(file1, 'identical', 'utf-8');
    await writeFile(file2, 'identical', 'utf-8');

    const snap1 = await captureFileState(file1);
    const snap2 = await captureFileState(file2);

    expect(snap1.state.contentHash).toBe(snap2.state.contentHash);
  });

  it('includes custom description when provided', async () => {
    const filePath = join(testDir, 'described.txt');
    await writeFile(filePath, 'data', 'utf-8');

    const snapshot = await captureFileState(filePath, 'Before editing config');

    expect(snapshot.description).toBe('Before editing config');
  });

  it('ISO-8601 timestamp format', async () => {
    const filePath = join(testDir, 'ts.txt');
    await writeFile(filePath, 'x', 'utf-8');

    const snapshot = await captureFileState(filePath);

    // ISO-8601 timestamp should parse cleanly
    const parsed = new Date(snapshot.timestamp);
    expect(parsed.getTime()).toBeGreaterThan(0);
  });
});
