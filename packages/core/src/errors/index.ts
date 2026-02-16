/**
 * Structured error types for ch4p.
 */

export class Ch4pError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'Ch4pError';
  }
}

export class SecurityError extends Ch4pError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'SECURITY_ERROR', context);
    this.name = 'SecurityError';
  }
}

export class ProviderError extends Ch4pError {
  constructor(message: string, public readonly provider: string, context?: Record<string, unknown>) {
    super(message, 'PROVIDER_ERROR', { ...context, provider });
    this.name = 'ProviderError';
  }
}

export class ToolError extends Ch4pError {
  constructor(message: string, public readonly tool: string, context?: Record<string, unknown>) {
    super(message, 'TOOL_ERROR', { ...context, tool });
    this.name = 'ToolError';
  }
}

export class ChannelError extends Ch4pError {
  constructor(message: string, public readonly channel: string, context?: Record<string, unknown>) {
    super(message, 'CHANNEL_ERROR', { ...context, channel });
    this.name = 'ChannelError';
  }
}

export class MemoryError extends Ch4pError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'MEMORY_ERROR', context);
    this.name = 'MemoryError';
  }
}

export class EngineError extends Ch4pError {
  public readonly retryable: boolean;

  constructor(
    message: string,
    public readonly engine: string,
    context?: Record<string, unknown>,
    retryable = true,
  ) {
    super(message, 'ENGINE_ERROR', { ...context, engine });
    this.name = 'EngineError';
    this.retryable = retryable;
  }
}

export class ConfigError extends Ch4pError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'CONFIG_ERROR', context);
    this.name = 'ConfigError';
  }
}
