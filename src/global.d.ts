import type { PrAtlasApi } from '../shared/contracts';

declare global {
  interface Window {
    prAtlas?: PrAtlasApi;
  }
}

export {};
