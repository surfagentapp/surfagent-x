import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export type TaskStep = {
  name: string;
  status: 'started' | 'completed' | 'failed';
  startedAt: string;
  finishedAt?: string;
  details?: unknown;
  error?: { message: string };
};

export type ScreenshotArtifact = {
  label: string;
  path: string;
  takenAt: string;
};

export type TaskRunBase = {
  ok: boolean;
  runId: string;
  steps: TaskStep[];
  artifacts: ScreenshotArtifact[];
  screenshots?: ScreenshotArtifact[];
  error?: {
    code: string;
    message: string;
    retryable?: boolean;
  };
};

export type CreateTaskRunnerRuntimeOptions = {
  rootDir: string;
  screenshot: (tabId?: string) => Promise<string>;
  slug?: (label: string) => string;
  now?: () => string;
};

function cleanBase64Image(input: string): string {
  const value = input.trim();
  const comma = value.indexOf(',');
  return value.startsWith('data:') && comma >= 0 ? value.slice(comma + 1) : value;
}

export function createTaskRunnerRuntime(options: CreateTaskRunnerRuntimeOptions) {
  const now = options.now ?? (() => new Date().toISOString());
  const slug = options.slug ?? ((label: string) => label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'artifact');

  function getArtifactList<TRun extends TaskRunBase>(run: TRun): ScreenshotArtifact[] {
    if (Array.isArray(run.screenshots) && run.screenshots !== run.artifacts) {
      run.artifacts = run.screenshots;
      return run.artifacts;
    }
    run.screenshots = run.artifacts;
    return run.artifacts;
  }

  async function ensureRunDir(runId: string): Promise<string> {
    const dir = join(options.rootDir, runId);
    await mkdir(dir, { recursive: true });
    return dir;
  }

  async function writeRunFile(runId: string, filename: string, content: string | Buffer, encoding?: BufferEncoding): Promise<string> {
    const dir = await ensureRunDir(runId);
    const fullPath = join(dir, filename);
    if (typeof content === 'string') await writeFile(fullPath, content, encoding ?? 'utf8');
    else await writeFile(fullPath, content);
    return fullPath;
  }

  async function writeRunManifest<TRun extends TaskRunBase>(run: TRun): Promise<string> {
    return writeRunFile(run.runId, 'run.json', JSON.stringify(run, null, 2));
  }

  async function captureScreenshot<TRun extends TaskRunBase>(run: TRun, tabId: string | undefined, label: string): Promise<ScreenshotArtifact | null> {
    const image = await options.screenshot(tabId);
    if (!image) return null;
    const payload = cleanBase64Image(image);
    const safeLabel = slug(label);
    const artifacts = getArtifactList(run);
    const path = await writeRunFile(run.runId, `${String(artifacts.length + 1).padStart(2, '0')}-${safeLabel}.png`, Buffer.from(payload, 'base64'));
    const artifact = { label, path, takenAt: now() };
    artifacts.push(artifact);
    await writeRunManifest(run);
    return artifact;
  }

  async function withStep<T, TRun extends TaskRunBase>(run: TRun, name: string, fn: () => Promise<T>): Promise<T> {
    const step: TaskStep = { name, status: 'started', startedAt: now() };
    run.steps.push(step);
    getArtifactList(run);
    await writeRunManifest(run);
    try {
      const result = await fn();
      step.status = 'completed';
      step.finishedAt = now();
      step.details = result;
      await writeRunManifest(run);
      return result;
    } catch (error) {
      step.status = 'failed';
      step.finishedAt = now();
      step.error = { message: error instanceof Error ? error.message : String(error) };
      await writeRunManifest(run);
      throw error;
    }
  }

  function makeRunId(task: string): string {
    return `${now().replace(/[-:.TZ]/g, '').slice(0, 14)}-${task}`;
  }

  return {
    makeRunId,
    writeRunManifest,
    captureScreenshot,
    withStep,
  };
}
