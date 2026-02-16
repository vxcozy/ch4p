/**
 * Tests for OutputSanitizer -- API key detection, token redaction,
 * PII stripping, private key removal, and custom pattern support.
 */

import { OutputSanitizer } from './output-sanitizer.js';

describe('OutputSanitizer', () => {
  let sanitizer: OutputSanitizer;

  beforeEach(() => {
    sanitizer = new OutputSanitizer();
  });

  // -----------------------------------------------------------------------
  // Clean text (no redaction needed)
  // -----------------------------------------------------------------------

  describe('clean text', () => {
    it('returns clean text unchanged', () => {
      const text = 'This is perfectly normal output with no secrets.';
      const result = sanitizer.sanitize(text);
      expect(result.clean).toBe(text);
      expect(result.redacted).toBe(false);
      expect(result.redactedPatterns).toBeUndefined();
    });

    it('handles empty string', () => {
      const result = sanitizer.sanitize('');
      expect(result.clean).toBe('');
      expect(result.redacted).toBe(false);
    });

    it('handles multiline text without secrets', () => {
      const text = 'Line 1\nLine 2\nLine 3\n';
      const result = sanitizer.sanitize(text);
      expect(result.clean).toBe(text);
      expect(result.redacted).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // OpenAI API keys
  // -----------------------------------------------------------------------

  describe('OpenAI API key detection', () => {
    it('redacts OpenAI API key', () => {
      const key = 'sk-' + 'a'.repeat(48);
      const text = `The API key is ${key}`;
      const result = sanitizer.sanitize(text);
      expect(result.clean).toContain('sk-[REDACTED]');
      expect(result.clean).not.toContain(key);
      expect(result.redacted).toBe(true);
      expect(result.redactedPatterns).toContain('OpenAI API key');
    });

    it('redacts multiple OpenAI keys', () => {
      const key1 = 'sk-' + 'a'.repeat(48);
      const key2 = 'sk-' + 'B'.repeat(48);
      const text = `Key 1: ${key1}, Key 2: ${key2}`;
      const result = sanitizer.sanitize(text);
      expect(result.clean).not.toContain(key1);
      expect(result.clean).not.toContain(key2);
    });

    it('does not redact short sk- prefixed strings', () => {
      const text = 'The variable sk-short is not an API key';
      const result = sanitizer.sanitize(text);
      // "sk-short" has fewer than 20 chars after "sk-", so it should not match
      expect(result.redacted).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Slack tokens
  // -----------------------------------------------------------------------

  describe('Slack token detection', () => {
    it('redacts Slack bot token (xoxb-)', () => {
      const token = 'xoxb-' + '1234567890-'.repeat(3) + 'abcdef1234';
      const text = `Use this token: ${token}`;
      const result = sanitizer.sanitize(text);
      expect(result.clean).toContain('xoxb-[REDACTED]');
      expect(result.clean).not.toContain(token);
      expect(result.redacted).toBe(true);
      expect(result.redactedPatterns).toContain('Slack token');
    });

    it('redacts Slack user token (xoxp-)', () => {
      const token = 'xoxp-' + '1234567890-'.repeat(3) + 'abcdef1234';
      const text = `User token: ${token}`;
      const result = sanitizer.sanitize(text);
      expect(result.clean).toContain('xoxp-[REDACTED]');
      expect(result.redacted).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // GitHub tokens
  // -----------------------------------------------------------------------

  describe('GitHub token detection', () => {
    it('redacts GitHub personal access token (ghp_)', () => {
      const token = 'ghp_' + 'A'.repeat(36);
      const text = `GITHUB_TOKEN=${token}`;
      const result = sanitizer.sanitize(text);
      expect(result.clean).toContain('ghp_[REDACTED]');
      expect(result.clean).not.toContain(token);
      expect(result.redactedPatterns).toContain('GitHub personal access token');
    });

    it('redacts GitHub OAuth token (gho_)', () => {
      const token = 'gho_' + 'B'.repeat(36);
      const text = `Token: ${token}`;
      const result = sanitizer.sanitize(text);
      expect(result.clean).toContain('gho_[REDACTED]');
    });

    it('redacts GitHub App token (ghu_)', () => {
      const token = 'ghu_' + 'C'.repeat(36);
      const text = `Token: ${token}`;
      const result = sanitizer.sanitize(text);
      expect(result.clean).toContain('ghu_[REDACTED]');
    });

    it('redacts GitHub App installation token (ghs_)', () => {
      const token = 'ghs_' + 'D'.repeat(36);
      const text = `Token: ${token}`;
      const result = sanitizer.sanitize(text);
      expect(result.clean).toContain('ghs_[REDACTED]');
    });

    it('redacts GitHub fine-grained PAT', () => {
      const token = 'github_pat_' + 'E'.repeat(40);
      const text = `Fine-grained: ${token}`;
      const result = sanitizer.sanitize(text);
      expect(result.clean).toContain('github_pat_[REDACTED]');
      expect(result.redactedPatterns).toContain('GitHub fine-grained PAT');
    });
  });

  // -----------------------------------------------------------------------
  // AWS credentials
  // -----------------------------------------------------------------------

  describe('AWS credential detection', () => {
    it('redacts AWS access key ID (AKIA...)', () => {
      const key = 'AKIA' + 'ABCDEFGHIJKLMNOP';
      const text = `aws_access_key_id = ${key}`;
      const result = sanitizer.sanitize(text);
      expect(result.clean).toContain('[AWS_KEY_REDACTED]');
      expect(result.clean).not.toContain(key);
      expect(result.redactedPatterns).toContain('AWS access key ID');
    });

    it('does not redact AKIA prefix when part of longer word', () => {
      // If it has alphanumeric chars immediately before, it should not match
      const text = 'The word xAKIA1234567890ABCDEF should not match';
      const result = sanitizer.sanitize(text);
      const hasAwsRedaction = result.redactedPatterns?.includes('AWS access key ID') ?? false;
      expect(hasAwsRedaction).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Bearer / Basic auth tokens
  // -----------------------------------------------------------------------

  describe('auth token detection', () => {
    it('redacts Bearer token', () => {
      const text = 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWI';
      const result = sanitizer.sanitize(text);
      expect(result.clean).toContain('Bearer [REDACTED]');
      expect(result.redacted).toBe(true);
      expect(result.redactedPatterns).toContain('Bearer token');
    });

    it('redacts Basic auth token', () => {
      const text = 'Authorization: Basic dXNlcjpwYXNzd29yZA==';
      const result = sanitizer.sanitize(text);
      expect(result.clean).toContain('Basic [REDACTED]');
      expect(result.redacted).toBe(true);
      expect(result.redactedPatterns).toContain('Authorization Basic');
    });
  });

  // -----------------------------------------------------------------------
  // PII (credit cards, SSN)
  // -----------------------------------------------------------------------

  describe('PII detection', () => {
    it('redacts Visa credit card number', () => {
      const text = 'Card: 4111111111111111';
      const result = sanitizer.sanitize(text);
      expect(result.clean).toContain('[CC_REDACTED]');
      expect(result.clean).not.toContain('4111111111111111');
      expect(result.redactedPatterns).toContain('Credit card number');
    });

    it('redacts Mastercard credit card number', () => {
      const text = 'Card: 5105105105105100';
      const result = sanitizer.sanitize(text);
      expect(result.clean).toContain('[CC_REDACTED]');
    });

    it('redacts American Express credit card number', () => {
      const text = 'Card: 378282246310005';
      const result = sanitizer.sanitize(text);
      expect(result.clean).toContain('[CC_REDACTED]');
    });

    it('redacts Social Security Number', () => {
      const text = 'SSN: 123-45-6789';
      const result = sanitizer.sanitize(text);
      expect(result.clean).toContain('[SSN_REDACTED]');
      expect(result.clean).not.toContain('123-45-6789');
      expect(result.redactedPatterns).toContain('Social Security Number');
    });

    it('redacts multiple SSNs', () => {
      const text = 'Person A: 111-22-3333, Person B: 444-55-6666';
      const result = sanitizer.sanitize(text);
      expect(result.clean).not.toContain('111-22-3333');
      expect(result.clean).not.toContain('444-55-6666');
    });
  });

  // -----------------------------------------------------------------------
  // Generic secret assignments
  // -----------------------------------------------------------------------

  describe('generic secret assignment detection', () => {
    it('redacts SECRET= assignment', () => {
      const text = 'SECRET=mysupersecretvalue1234567890';
      const result = sanitizer.sanitize(text);
      expect(result.clean).toContain('[SECRET_REDACTED]');
      expect(result.redacted).toBe(true);
    });

    it('redacts API_KEY= assignment', () => {
      const text = 'API_KEY="sk_test_FAKE000000000000placeholder"';
      const result = sanitizer.sanitize(text);
      expect(result.clean).toContain('[SECRET_REDACTED]');
    });

    it('redacts PASSWORD= assignment', () => {
      const text = "PASSWORD='hunter2hunter2hunter';";
      const result = sanitizer.sanitize(text);
      expect(result.clean).toContain('[SECRET_REDACTED]');
    });

    it('redacts TOKEN= assignment', () => {
      const text = 'TOKEN: abcdefghijklmnopqrstuvwxyz123456';
      const result = sanitizer.sanitize(text);
      expect(result.clean).toContain('[SECRET_REDACTED]');
    });
  });

  // -----------------------------------------------------------------------
  // Private key blocks
  // -----------------------------------------------------------------------

  describe('private key detection', () => {
    it('redacts RSA private key', () => {
      const text = `Here is the key:
-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEA...lots of base64...
-----END RSA PRIVATE KEY-----
Do not share this!`;
      const result = sanitizer.sanitize(text);
      expect(result.clean).toContain('[PRIVATE_KEY_REDACTED]');
      expect(result.clean).not.toContain('MIIEowIBAAKCAQEA');
      expect(result.redactedPatterns).toContain('Private key block');
    });

    it('redacts EC private key', () => {
      const text = `-----BEGIN EC PRIVATE KEY-----
MHQCAQEEIBkg...
-----END EC PRIVATE KEY-----`;
      const result = sanitizer.sanitize(text);
      expect(result.clean).toContain('[PRIVATE_KEY_REDACTED]');
    });

    it('redacts generic private key', () => {
      const text = `-----BEGIN PRIVATE KEY-----
base64data...
-----END PRIVATE KEY-----`;
      const result = sanitizer.sanitize(text);
      expect(result.clean).toContain('[PRIVATE_KEY_REDACTED]');
    });

    it('redacts OPENSSH private key', () => {
      const text = `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAA...
-----END OPENSSH PRIVATE KEY-----`;
      const result = sanitizer.sanitize(text);
      expect(result.clean).toContain('[PRIVATE_KEY_REDACTED]');
    });
  });

  // -----------------------------------------------------------------------
  // Multiple redactions in one text
  // -----------------------------------------------------------------------

  describe('multiple redactions', () => {
    it('redacts multiple different secret types', () => {
      const openaiKey = 'sk-' + 'a'.repeat(48);
      const ghToken = 'ghp_' + 'B'.repeat(36);
      const text = `OpenAI: ${openaiKey}\nGitHub: ${ghToken}`;
      const result = sanitizer.sanitize(text);
      expect(result.clean).toContain('sk-[REDACTED]');
      expect(result.clean).toContain('ghp_[REDACTED]');
      expect(result.redacted).toBe(true);
      expect(result.redactedPatterns).toContain('OpenAI API key');
      expect(result.redactedPatterns).toContain('GitHub personal access token');
    });

    it('redacts secrets in JSON output', () => {
      const key = 'sk-' + 'x'.repeat(48);
      const text = `{"api_key": "${key}", "model": "gpt-4"}`;
      const result = sanitizer.sanitize(text);
      expect(result.clean).not.toContain(key);
      expect(result.redacted).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Custom patterns (extra patterns)
  // -----------------------------------------------------------------------

  describe('custom extra patterns', () => {
    it('supports additional user-defined patterns', () => {
      const customSanitizer = new OutputSanitizer([
        {
          name: 'Custom internal code',
          pattern: /MYAPP-[a-z]{10}-[a-z]{10}/g,
          replacement: '[INTERNAL_REDACTED]',
        },
      ]);

      const code = 'MYAPP-abcdefghij-klmnopqrst';
      const text = `The reference is ${code} for this task`;
      const result = customSanitizer.sanitize(text);
      expect(result.clean).toContain('[INTERNAL_REDACTED]');
      expect(result.redacted).toBe(true);
      expect(result.redactedPatterns).toContain('Custom internal code');
    });

    it('applies both built-in and custom patterns', () => {
      const customSanitizer = new OutputSanitizer([
        {
          name: 'Company secret',
          pattern: /CORP_[A-Za-z0-9]{16,}/g,
          replacement: '[CORP_REDACTED]',
        },
      ]);

      const openaiKey = 'sk-' + 'z'.repeat(48);
      const corpSecret = 'CORP_' + 'x'.repeat(20);
      const text = `${openaiKey} and ${corpSecret}`;
      const result = customSanitizer.sanitize(text);
      expect(result.clean).toContain('sk-[REDACTED]');
      expect(result.clean).toContain('[CORP_REDACTED]');
    });
  });

  // -----------------------------------------------------------------------
  // Repeated calls (regex statefulness)
  // -----------------------------------------------------------------------

  describe('repeated calls', () => {
    it('works correctly on repeated sanitize calls', () => {
      const key = 'sk-' + 'r'.repeat(48);
      const text = `Key: ${key}`;

      // Call sanitize multiple times to test regex lastIndex reset
      for (let i = 0; i < 5; i++) {
        const result = sanitizer.sanitize(text);
        expect(result.clean).toContain('sk-[REDACTED]');
        expect(result.redacted).toBe(true);
      }
    });
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------

  describe('edge cases', () => {
    it('handles text with only whitespace', () => {
      const result = sanitizer.sanitize('   \n\t  ');
      expect(result.redacted).toBe(false);
    });

    it('handles very long text', () => {
      const longText = 'a'.repeat(100_000);
      const result = sanitizer.sanitize(longText);
      expect(result.redacted).toBe(false);
      expect(result.clean).toBe(longText);
    });

    it('preserves surrounding text when redacting', () => {
      const key = 'sk-' + 'm'.repeat(48);
      const text = `Before ${key} After`;
      const result = sanitizer.sanitize(text);
      expect(result.clean).toBe('Before sk-[REDACTED] After');
    });
  });

  // -----------------------------------------------------------------------
  // Telegram bot tokens
  // -----------------------------------------------------------------------

  describe('Telegram bot token detection', () => {
    it('redacts a Telegram bot token', () => {
      const token = '123456789:ABCdefGhIjKlMnOpQrStUvWxYz0123456789';
      const text = `Bot token: ${token}`;
      const result = sanitizer.sanitize(text);
      expect(result.clean).toContain('[TELEGRAM_BOT_TOKEN_REDACTED]');
      expect(result.clean).not.toContain(token);
      expect(result.redacted).toBe(true);
      expect(result.redactedPatterns).toContain('Telegram bot token');
    });

    it('does not false-positive on short numeric:alpha strings', () => {
      const result = sanitizer.sanitize('123:abc');
      expect(result.redacted).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Discord bot tokens
  // -----------------------------------------------------------------------

  describe('Discord bot token detection', () => {
    it('redacts a Discord bot token', () => {
      const token = 'MTIzNDU2Nzg5MDEyMzQ1Njc4.OTkxMj.abcdefghijklmnopqrstuvwxyz12345';
      const text = `Discord token: ${token}`;
      const result = sanitizer.sanitize(text);
      expect(result.clean).toContain('[DISCORD_BOT_TOKEN_REDACTED]');
      expect(result.clean).not.toContain(token);
      expect(result.redacted).toBe(true);
      expect(result.redactedPatterns).toContain('Discord bot token');
    });
  });

  // -----------------------------------------------------------------------
  // Stripe keys
  // -----------------------------------------------------------------------

  describe('Stripe key detection', () => {
    it('redacts Stripe secret key', () => {
      const key = 'sk_live_' + 'a'.repeat(24);
      const result = sanitizer.sanitize(`Key: ${key}`);
      expect(result.clean).toContain('sk_live_[REDACTED]');
      expect(result.clean).not.toContain(key);
      expect(result.redactedPatterns).toContain('Stripe secret key');
    });

    it('redacts Stripe publishable key', () => {
      const key = 'pk_live_' + 'b'.repeat(24);
      const result = sanitizer.sanitize(`Key: ${key}`);
      expect(result.clean).toContain('pk_live_[REDACTED]');
      expect(result.clean).not.toContain(key);
      expect(result.redactedPatterns).toContain('Stripe publishable key');
    });

    it('redacts Stripe restricted key', () => {
      const key = 'rk_live_' + 'c'.repeat(24);
      const result = sanitizer.sanitize(`Key: ${key}`);
      expect(result.clean).toContain('rk_live_[REDACTED]');
      expect(result.clean).not.toContain(key);
      expect(result.redactedPatterns).toContain('Stripe restricted key');
    });
  });

  // -----------------------------------------------------------------------
  // SendGrid API keys
  // -----------------------------------------------------------------------

  describe('SendGrid API key detection', () => {
    it('redacts SendGrid API key', () => {
      const key = 'SG.' + 'a'.repeat(22) + '.' + 'b'.repeat(22);
      const result = sanitizer.sanitize(`SendGrid: ${key}`);
      expect(result.clean).toContain('SG.[REDACTED]');
      expect(result.clean).not.toContain(key);
      expect(result.redactedPatterns).toContain('SendGrid API key');
    });
  });

  // -----------------------------------------------------------------------
  // JWT tokens
  // -----------------------------------------------------------------------

  describe('JWT token detection', () => {
    it('redacts a JWT token', () => {
      const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.Rq8IjqbaZ7lN_aB_abc123';
      const result = sanitizer.sanitize(`Token: ${jwt}`);
      expect(result.clean).toContain('[JWT_REDACTED]');
      expect(result.clean).not.toContain(jwt);
      expect(result.redactedPatterns).toContain('JWT token');
    });
  });

  // -----------------------------------------------------------------------
  // Database connection strings
  // -----------------------------------------------------------------------

  describe('database connection string detection', () => {
    it('redacts PostgreSQL connection string', () => {
      const connStr = 'postgres://admin:secretpass@db.example.com:5432/mydb';
      const result = sanitizer.sanitize(`DB: ${connStr}`);
      expect(result.clean).toContain('[DB_CONNECTION_REDACTED]');
      expect(result.clean).not.toContain('secretpass');
      expect(result.redactedPatterns).toContain('Database connection string');
    });

    it('redacts MongoDB connection string', () => {
      const connStr = 'mongodb+srv://user:pass@cluster.mongodb.net/dbname';
      const result = sanitizer.sanitize(`Mongo: ${connStr}`);
      expect(result.clean).toContain('[DB_CONNECTION_REDACTED]');
      expect(result.clean).not.toContain('pass');
    });

    it('redacts Redis connection string', () => {
      const connStr = 'redis://default:mysecret@redis.example.com:6379';
      const result = sanitizer.sanitize(`Redis: ${connStr}`);
      expect(result.clean).toContain('[DB_CONNECTION_REDACTED]');
      expect(result.clean).not.toContain('mysecret');
    });

    it('redacts MySQL connection string', () => {
      const connStr = 'mysql://root:password123@localhost:3306/app';
      const result = sanitizer.sanitize(`MySQL: ${connStr}`);
      expect(result.clean).toContain('[DB_CONNECTION_REDACTED]');
      expect(result.clean).not.toContain('password123');
    });
  });
});
