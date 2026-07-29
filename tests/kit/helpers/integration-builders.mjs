export function validHost(overrides = {}) {
  return {
    id: 'test-host',
    label: 'Test Host',
    install: { bin: 'test-host', externalInstallPolicy: 'detect-never-overwrite' },
    capabilities: {
      canDriveSession: true,
      canBePrimary: true,
      canRouteActivities: true,
      transcripts: true,
      usage: true,
      nativeMcpConfig: true,
      nativeGuidance: true,
    },
    auth: { apiKeyEnv: ['TEST_HOST_API_KEY'], keyOverridesLogin: false },
    configProjection: 'test-projection',
    observability: ['test-transcripts'],
    ...overrides,
  };
}

export function validProvider(overrides = {}) {
  return {
    id: 'test-provider',
    label: 'Test Provider',
    billing: 'metered',
    credentials: { kind: 'env', names: ['TEST_PROVIDER_API_KEY'] },
    transports: ['openai-compatible'],
    capabilities: {
      modelDiscovery: false,
      runtimeDiscovery: false,
      pricing: 'dated-offline',
      quota: false,
      cacheAccounting: 'unknown',
    },
    projections: ['test-projection'],
    observability: ['test-provider-metadata'],
    ...overrides,
  };
}

export function validProjection(overrides = {}) {
  return {
    id: 'test-projection',
    format: 'json',
    lifecycle: ['detect', 'plan', 'apply', 'verify', 'undo'],
    ...overrides,
  };
}

export function validObservability(overrides = {}) {
  return {
    id: 'test-transcripts',
    kinds: ['transcript'],
    ...overrides,
  };
}

export function validBinding(overrides = {}) {
  return {
    id: 'test-provider-via-test-host',
    host: 'test-host',
    provider: 'test-provider',
    transport: 'openai-compatible',
    endpoint: 'https://inference.example.test/v1',
    model: 'test/model',
    source: 'user',
    managedBy: 'agentic-kit',
    ...overrides,
  };
}

export function validRegistries(overrides = {}) {
  return {
    hosts: [validHost()],
    providers: [validProvider()],
    projections: [validProjection()],
    observability: [
      validObservability(),
      validObservability({ id: 'test-provider-metadata', kinds: ['provider-metadata'] }),
    ],
    ...overrides,
  };
}
