import {OPENCLAW_TOKEN, OPENROUTER_API_KEY, GATEWAY_WS_URL} from '@env';

export interface PipelineConfig {
  gateway: {wsUrl: string; token: string; sessionKey: string};
  vision: {apiKey: string; model: string};
}

export const DEFAULT_CONFIG: PipelineConfig = {
  gateway: {
    wsUrl: 'wss://localhost:18789',
    token: '',
    sessionKey: 'agent:main:sinain',
  },
  vision: {
    apiKey: '',
    model: 'google/gemini-2.5-flash',
  },
};

export function configFromEnv(): PipelineConfig {
  return {
    ...DEFAULT_CONFIG,
    gateway: {
      ...DEFAULT_CONFIG.gateway,
      wsUrl: GATEWAY_WS_URL || DEFAULT_CONFIG.gateway.wsUrl,
      token: OPENCLAW_TOKEN ?? '',
    },
    vision: {...DEFAULT_CONFIG.vision, apiKey: OPENROUTER_API_KEY ?? ''},
  };
}
