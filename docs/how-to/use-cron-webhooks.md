# How to Use Cron Jobs and Webhooks

This guide explains how to schedule recurring agent tasks and set up inbound webhook triggers.

---

## Cron Jobs

### Step 1: Enable the Scheduler

Add a `scheduler` section to `~/.ch4p/config.json`:

```json
{
  "scheduler": {
    "enabled": true,
    "jobs": [
      {
        "name": "morning-briefing",
        "schedule": "0 9 * * 1-5",
        "message": "Give me a morning briefing: check the weather, top news, and my calendar for today."
      },
      {
        "name": "daily-backup-check",
        "schedule": "0 22 * * *",
        "message": "Check if today's backup completed successfully."
      }
    ]
  }
}
```

### Step 2: Cron Expression Format

Standard 5-field expressions:

```
 *  *  *  *  *
 |  |  |  |  |
 |  |  |  |  +-- Day of week (0-6, Sun=0)
 |  |  |  +---- Month (1-12)
 |  |  +------- Day of month (1-31)
 |  +---------- Hour (0-23)
 +------------- Minute (0-59)
```

Supported syntax: wildcards (`*`), ranges (`1-5`), lists (`0,15,30`), steps (`*/5`).

### Examples

| Expression | Description |
|------------|-------------|
| `0 9 * * *` | Every day at 9:00 AM |
| `*/15 * * * *` | Every 15 minutes |
| `0 9 * * 1-5` | Weekdays at 9:00 AM |
| `30 18 1 * *` | 1st of every month at 6:30 PM |

---

## Webhooks

### Step 1: Enable Webhooks

```json
{
  "webhooks": {
    "enabled": true
  }
}
```

### Step 2: Send Webhook Requests

```bash
# Trigger a webhook
curl -X POST http://localhost:3847/webhooks/deploy-check \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_PAIRING_TOKEN" \
  -d '{"message": "Check the latest deployment status", "userId": "ci-bot"}'
```

### Webhook Payload

```json
{
  "message": "The text message to send to the agent",
  "userId": "optional-user-identifier"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `message` | `string` | Yes | Message text sent to the agent. |
| `userId` | `string` | No | User identifier for the synthetic message. |

### Authentication

Webhooks require pairing token authentication (same as other gateway API endpoints). Include the token as a Bearer token in the Authorization header.

---

## How It Works

Both cron jobs and webhooks create synthetic inbound messages and process them through the same agent loop as channel messages. The agent sees them as regular messages and responds accordingly.
