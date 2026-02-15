/**
 * IIdentityProvider — on-chain agent identity contract
 *
 * Defines the trait interface for agent identity, reputation, and validation
 * registries. Designed for ERC-8004 (Trustless Agents) but abstract enough
 * to support other identity standards.
 *
 * This is a plugin hook — @ch4p/core defines the types only (zero deps).
 * Concrete implementations (e.g., @ch4p/plugin-erc8004) bring the chain
 * client and contract ABIs. If no identity provider is configured, all
 * identity-aware code paths are skipped.
 *
 * @see https://eips.ethereum.org/EIPS/eip-8004
 */

// ---------------------------------------------------------------------------
// Agent identity types
// ---------------------------------------------------------------------------

export interface AgentIdentity {
  /** On-chain agent ID (ERC-721 tokenId in ERC-8004). */
  agentId: string;
  /** Registry address or global identifier (e.g., "eip155:1:0x742..."). */
  registry: string;
  /** Chain ID (EIP-155). */
  chainId: number;
  /** Full global identifier string. */
  globalId: string;
  /** Owner address (NFT holder in ERC-8004). */
  ownerAddress: string;
  /** Optional operational wallet (bound via EIP-712 in ERC-8004). */
  agentWallet?: string;
  /** Agent URI — resolves to an AgentRegistrationFile. */
  uri?: string;
}

export interface AgentRegistrationFile {
  /** Schema type identifier (MUST). */
  type: string;
  /** Agent display name (MUST). */
  name: string;
  /** Agent description (MUST). */
  description: string;
  /** Agent avatar/image URL (MUST). */
  image: string;
  /** Service endpoints this agent exposes. */
  services: AgentService[];
  /** Whether the agent supports x402 payment protocol. */
  x402Support?: boolean;
  /** Whether the agent is actively running. */
  active?: boolean;
  /** Cross-chain registrations for the same agent. */
  registrations?: CrossChainRegistration[];
  /** Trust models this agent supports. */
  supportedTrust?: string[];
}

export interface AgentService {
  /** Service type: "web", "a2a", "mcp", "oasf", "ens", "did", "email". */
  name: string;
  /** Service endpoint URL. */
  endpoint: string;
  /** Protocol version (SHOULD be provided). */
  version?: string;
  /** Capabilities/skills this service offers. */
  skills?: string[];
  /** Domain areas this service covers. */
  domains?: string[];
}

export interface CrossChainRegistration {
  /** Agent ID on the other chain. */
  agentId: string;
  /** Registry identifier on the other chain. */
  agentRegistry: string;
}

// ---------------------------------------------------------------------------
// Reputation types
// ---------------------------------------------------------------------------

export interface ReputationSummary {
  /** Number of feedback entries matching the query. */
  count: number;
  /** Raw aggregated value (signed — negative feedback is possible). */
  summaryValue: number;
  /** Decimal precision of summaryValue (0–18). */
  summaryValueDecimals: number;
  /** Convenience: summaryValue / 10^summaryValueDecimals. */
  normalizedScore: number;
}

export interface FeedbackEntry {
  agentId: string;
  clientAddress: string;
  feedbackIndex: number;
  value: number;
  valueDecimals: number;
  tag1?: string;
  tag2?: string;
  isRevoked: boolean;
}

export interface FeedbackOpts {
  tag1?: string;
  tag2?: string;
  endpoint?: string;
  feedbackURI?: string;
  feedbackHash?: string;
}

// ---------------------------------------------------------------------------
// Validation types
// ---------------------------------------------------------------------------

export interface ValidationSummary {
  /** Number of validation responses matching the query. */
  count: number;
  /** Average response score (0–100). */
  averageResponse: number;
}

export interface ValidationStatus {
  validatorAddress: string;
  agentId: string;
  /** Response score: 0 = fail, 100 = pass, intermediate allowed. */
  response: number;
  responseHash: string;
  tag: string;
  lastUpdate: Date;
}

// ---------------------------------------------------------------------------
// Trust decision (used by ISecurityPolicy integration)
// ---------------------------------------------------------------------------

export interface TrustContext {
  /** What operation is being gated. */
  operation: 'delegate' | 'mcp_connect' | 'a2a_call' | 'tool_proxy';
  /** Pre-fetched reputation data (if available). */
  reputation?: ReputationSummary;
  /** Pre-fetched validation data (if available). */
  validation?: ValidationSummary;
}

export interface TrustDecision {
  allowed: boolean;
  reason: string;
  reputationScore?: number;
  validationScore?: number;
}

// ---------------------------------------------------------------------------
// IIdentityProvider interface
// ---------------------------------------------------------------------------

export interface IIdentityProvider {
  /** Unique identifier for this provider implementation. */
  readonly id: string;
  /** Chain ID this provider is connected to. */
  readonly chainId: number;

  // --- Identity Registry ---

  /** Register a new agent identity. Returns the minted identity. */
  register(uri?: string, metadata?: Array<{ key: string; value: Uint8Array }>): Promise<AgentIdentity>;
  /** Look up an existing agent identity by ID. */
  getIdentity(agentId: string): Promise<AgentIdentity | null>;
  /** Update the agent's URI (points to registration JSON). */
  setAgentURI(agentId: string, uri: string): Promise<void>;
  /** Set a metadata key-value pair on the agent. */
  setMetadata(agentId: string, key: string, value: Uint8Array): Promise<void>;
  /** Read a metadata value by key. */
  getMetadata(agentId: string, key: string): Promise<Uint8Array | null>;

  // --- Reputation Registry ---

  /** Get aggregated reputation for an agent, filtered by trusted clients. */
  getReputation(agentId: string, trustedClients?: string[], tag1?: string, tag2?: string): Promise<ReputationSummary>;
  /** Submit feedback for an agent after an interaction. */
  submitFeedback(agentId: string, value: number, decimals: number, opts?: FeedbackOpts): Promise<void>;
  /** Read a specific feedback entry. */
  readFeedback(agentId: string, clientAddress: string, feedbackIndex: number): Promise<FeedbackEntry>;

  // --- Validation Registry ---

  /** Request third-party validation of this agent. */
  requestValidation(agentId: string, validatorAddress: string, requestURI: string, requestHash: string): Promise<void>;
  /** Get the status of a specific validation request. */
  getValidationStatus(requestHash: string): Promise<ValidationStatus | null>;
  /** Get aggregated validation scores, filtered by trusted validators. */
  getValidationSummary(agentId: string, trustedValidators?: string[], tag?: string): Promise<ValidationSummary>;

  // --- Service Discovery ---

  /** Resolve an agent's URI to its registration file. */
  resolveAgentURI(agentId: string): Promise<AgentRegistrationFile | null>;

  // --- Trust Assessment ---

  /** Evaluate whether an external agent meets trust thresholds. */
  assessTrust(agentId: string, context: TrustContext): Promise<TrustDecision>;
}
