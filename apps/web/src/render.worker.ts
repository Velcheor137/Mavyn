/// <reference lib="webworker" />
import { render, type RenderOptions } from '@mdr/markdown-engine';

interface Request {
  id: number;
  source: string;
  options: RenderOptions;
}

self.onmessage = (event: MessageEvent<Request>) => {
  const { id, source, options } = event.data;
  try {
    self.postMessage({ id, result: render(source, options) });
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
};
