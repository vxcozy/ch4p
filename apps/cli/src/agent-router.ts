/**
 * AgentRouter — config-driven multi-agent routing for the gateway.
 *
 * Evaluates routing rules (channel ID + message text regex) to select
 * the appropriate named agent configuration for each inbound message.
 * Rules are tested in order; the first match wins.
 *
 * Design goals:
 *   - Zero dependencies beyond @ch4p/core
 *   - Deterministic: same input always produces same routing decision
 *   - Safe defaults: falls back to the global config if no rule matches
 *   - No mutation: immutable RoutingDecision objects
 */

import type { Ch4pConfig, InboundMessage } from '@ch4p/core';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RoutingDecision {
  /** Name of the matched agent ("default" if no rule matched). */
  agentName: string;
  /** Custom system prompt for this agent, or undefined to use default. */
  systemPrompt?: string;
  /** Model override, or undefined to use config.agent.model. */
  model?: string;
  /** Max loop iterations for this agent (default: 20). */
  maxIterations: number;
  /** Tools to exclude, merged with global exclusions. */
  toolExclude: string[];
}

// ---------------------------------------------------------------------------
// AgentRouter
// ---------------------------------------------------------------------------

export class AgentRouter {
  private readonly compiledRules: Array<{
    channelPattern: RegExp | null;
    matchPattern: RegExp | null;
    agent: string;
  }>;

  constructor(private readonly config: Ch4pConfig) {
    const rules = config.routing?.rules ?? [];

    // Pre-compile patterns once at construction time.
    this.compiledRules = rules.map((rule) => {
      const channelPattern =
        rule.channel && rule.channel !== '*'
          ? new RegExp(`^${rule.channel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i')
          : null;

      const matchPattern = rule.match ? new RegExp(rule.match, 'i') : null;

      return { channelPattern, matchPattern, agent: rule.agent };
    });
  }

  /**
   * Evaluate routing rules against an inbound message.
   *
   * @param msg   The inbound message from any channel.
   * @param defaultSystemPrompt  The system prompt built for the default agent.
   * @returns     A RoutingDecision describing which agent to use.
   */
  route(msg: InboundMessage, defaultSystemPrompt: string): RoutingDecision {
    const channelId = msg.channelId ?? '';
    const text = msg.text ?? '';
    const agents = this.config.routing?.agents ?? {};

    for (const rule of this.compiledRules) {
      // Test channel pattern (null = match any channel).
      if (rule.channelPattern && !rule.channelPattern.test(channelId)) {
        continue;
      }

      // Test text pattern (null = match any message).
      if (rule.matchPattern && !rule.matchPattern.test(text)) {
        continue;
      }

      // Rule matched — look up the agent config.
      const agentCfg = agents[rule.agent];
      if (!agentCfg) {
        // Agent named in rule doesn't exist in agents map — skip silently.
        continue;
      }

      return this.buildDecision(rule.agent, agentCfg, defaultSystemPrompt);
    }

    // No rule matched — return the default routing decision.
    return this.defaultDecision(defaultSystemPrompt);
  }

  /**
   * Return a decision for a named agent. Used by tests and direct lookups.
   */
  routeToAgent(agentName: string, defaultSystemPrompt: string): RoutingDecision {
    const agents = this.config.routing?.agents ?? {};
    const agentCfg = agents[agentName];
    if (!agentCfg) return this.defaultDecision(defaultSystemPrompt);
    return this.buildDecision(agentName, agentCfg, defaultSystemPrompt);
  }

  /** True when routing configuration is present and has at least one rule. */
  hasRules(): boolean {
    return (this.config.routing?.rules?.length ?? 0) > 0;
  }

  /** List all defined agent names (excluding "default"). */
  agentNames(): string[] {
    return Object.keys(this.config.routing?.agents ?? {});
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private buildDecision(
    agentName: string,
    agentCfg: NonNullable<NonNullable<Ch4pConfig['routing']>['agents']>[string],
    defaultSystemPrompt: string,
  ): RoutingDecision {
    return {
      agentName,
      systemPrompt: agentCfg.systemPrompt ?? defaultSystemPrompt,
      model: agentCfg.model,
      maxIterations: agentCfg.maxIterations ?? 20,
      toolExclude: agentCfg.toolExclude ?? [],
    };
  }

  private defaultDecision(defaultSystemPrompt: string): RoutingDecision {
    return {
      agentName: 'default',
      systemPrompt: defaultSystemPrompt,
      model: undefined,
      maxIterations: 20,
      toolExclude: [],
    };
  }
}
