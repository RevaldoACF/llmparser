export class LLMStreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LLMStreamError";
  }
}

export class ProtocolError extends LLMStreamError {
  raw: string;
  constructor(message: string, raw = "") {
    super(message);
    this.name = "ProtocolError";
    this.raw = raw;
  }
}

export class ProviderError extends LLMStreamError {
  code: string;
  provider_error?: Record<string, unknown>;
  constructor(code: string, message: string, provider_error?: Record<string, unknown>) {
    super(message);
    this.name = "ProviderError";
    this.code = code;
    this.provider_error = provider_error;
  }
}

export class UnsupportedProviderError extends LLMStreamError {
  constructor(provider: string) {
    super(`unknown provider: ${provider}`);
    this.name = "UnsupportedProviderError";
  }
}

export class ToolArgumentsError extends LLMStreamError {
  toolName: string;
  raw_arguments: string;
  constructor(toolName: string, raw_arguments: string, brief = "") {
    super(`invalid tool arguments for '${toolName}': ${brief}`.trim());
    this.name = "ToolArgumentsError";
    this.toolName = toolName;
    this.raw_arguments = raw_arguments;
  }
}