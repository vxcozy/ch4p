/**
 * Cloudflare Tunnel provider — exposes local gateway via Cloudflare Tunnels.
 *
 * Uses the `cloudflared` CLI binary to create a Quick Tunnel (no account
 * required) or a named tunnel with authentication.
 *
 * Quick tunnel: `cloudflared tunnel --url http://localhost:{port}`
 * Named tunnel: `cloudflared tunnel run --url http://localhost:{port} {name}`
 *
 * Zero external dependencies — uses Node.js child_process only.
 */

import type { ITunnelProvider, TunnelConfig, TunnelInfo } from '@ch4p/core';
import { spawn, type ChildProcess } from 'node:child_process';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface CloudflareTunnelConfig extends TunnelConfig {
  /** Tunnel name for named tunnels. If omitted, uses a Quick Tunnel. */
  tunnelName?: string;
  /** Path to cloudflared binary. Default: 'cloudflared'. */
  binaryPath?: string;
  /** Protocol. Default: 'http'. */
  protocol?: 'http' | 'https';
}

// ---------------------------------------------------------------------------
// CloudflareTunnel
// ---------------------------------------------------------------------------

export class CloudflareTunnel implements ITunnelProvider {
  readonly id = 'cloudflare';

  private process: ChildProcess | null = null;
  private publicUrl: string | null = null;
  private active = false;
  private startedAt: Date | null = null;

  // -----------------------------------------------------------------------
  // ITunnelProvider implementation
  // -----------------------------------------------------------------------

  async start(config: TunnelConfig): Promise<TunnelInfo> {
    if (this.active) {
      throw new Error('Cloudflare tunnel is already running');
    }

    const cfg = config as CloudflareTunnelConfig;
    const binaryPath = cfg.binaryPath ?? 'cloudflared';
    const protocol = cfg.protocol ?? 'http';
    const localUrl = `${protocol}://localhost:${config.port}`;

    const args: string[] = ['tunnel'];

    if (cfg.tunnelName) {
      args.push('run', '--url', localUrl, cfg.tunnelName);
    } else {
      args.push('--url', localUrl);
    }

    return new Promise<TunnelInfo>((resolve, reject) => {
      const child = spawn(binaryPath, args, {
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      this.process = child;
      let resolved = false;
      let stderr = '';

      // Cloudflare outputs the public URL to stderr.
      child.stderr?.on('data', (data: Buffer) => {
        const text = data.toString();
        stderr += text;

        // Quick Tunnel URL pattern: https://<random>.trycloudflare.com
        const urlMatch = text.match(/(https:\/\/[a-z0-9-]+\.trycloudflare\.com)/);
        if (urlMatch && !resolved) {
          resolved = true;
          this.publicUrl = urlMatch[1]!;
          this.active = true;
          this.startedAt = new Date();
          resolve({
            publicUrl: this.publicUrl,
            provider: this.id,
            startedAt: this.startedAt,
          });
        }

        // Named tunnel URL pattern: Registered tunnel connection
        const namedMatch = text.match(/https:\/\/([a-z0-9-]+\.cfargotunnel\.com)/);
        if (namedMatch && !resolved && cfg.tunnelName) {
          resolved = true;
          this.publicUrl = `https://${namedMatch[1]}`;
          this.active = true;
          this.startedAt = new Date();
          resolve({
            publicUrl: this.publicUrl,
            provider: this.id,
            startedAt: this.startedAt,
          });
        }

        // Fallback: match any https URL on a Cloudflare domain not yet matched.
        if (!resolved) {
          const fallback = text.match(/(https:\/\/[a-z0-9-]+\.[a-z0-9.-]*cloudflare[a-z]*\.[a-z]+)/);
          if (fallback) {
            resolved = true;
            this.publicUrl = fallback[1]!;
            this.active = true;
            this.startedAt = new Date();
            resolve({
              publicUrl: this.publicUrl,
              provider: this.id,
              startedAt: this.startedAt,
            });
          }
        }
      });

      child.on('error', (err) => {
        if (!resolved) {
          resolved = true;
          reject(new Error(`Failed to start cloudflared: ${err.message}`));
        }
      });

      child.on('close', (code) => {
        this.active = false;
        if (!resolved) {
          resolved = true;
          reject(new Error(
            `cloudflared exited with code ${code}${stderr ? ': ' + stderr.slice(0, 500) : ''}`,
          ));
        }
      });

      // Timeout after 30 seconds.
      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          try { child.kill('SIGTERM'); } catch { /* ignore */ }
          reject(new Error('Cloudflare tunnel startup timed out'));
        }
      }, 30_000);
    });
  }

  async stop(): Promise<void> {
    if (this.process && !this.process.killed) {
      this.process.kill('SIGTERM');
    }
    this.process = null;
    this.publicUrl = null;
    this.active = false;
  }

  isActive(): boolean {
    return this.active;
  }

  getPublicUrl(): string | null {
    return this.publicUrl;
  }
}
