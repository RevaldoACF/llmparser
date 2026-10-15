// pipeline
export {
  parseStream,
  parseEvents,
  parseTokens,
  sentenceTransform,
  wrapStream,
  ParserCore,
  type ChunkSource,
  type PipelineOptions,
  type StreamFormat,
} from "./pipeline";

// types
export {
  type BufferOptions,
  type BufferPreset,
  type BufferLike,
  type BufferStrategy,
  type CodeBlockMode,
  type OnError,
  type StreamEvent,
  type EventType,
  type ToolCall,
  PRESET_VOICE,
  PRESET_UI,
  resolveBuffer,
  resolveBufferOptions,
  type ResolvedBufferOptions,
  codepointLen,
  cps,
  isSpace,
  isDigit,
  isAlpha,
  isAlnum,
  normalizeAbbrev,
} from "./types";

// buffer
export {
  SentenceBuffer,
  sanitizeForTts,
  withholdLen,
  type GuardStepResult,
} from "./buffer";

// tools
export {
  StreamingToolParser,
  partialJson,
  type ToolSlot,
} from "./toolParser";

// providers
export {
  type ProviderName,
  type ProviderAdapter,
  OpenAIAdapter,
  AnthropicAdapter,
  GeminiAdapter,
  GroqAdapter,
  GenericAdapter,
  detectProvider,
  createAdapter,
  PROVIDERS,
  DEFAULT_TEXT_PATHS,
  resolvePath,
} from "./providers";

// decoders
export {
  SSEDecoder,
  JsonLinesDecoder,
  parseJson,
  type WireRecord,
  type Chunk,
} from "./decoders";

// errors
export {
  LLMStreamError,
  ProtocolError,
  ProviderError,
  ToolArgumentsError,
  UnsupportedProviderError,
} from "./errors";

export const VERSION = "0.1.0";