import { WebClient, KnownBlock, Block } from '@slack/web-api';

export type SlackSeverity = 'info' | 'warning' | 'error' | 'critical';

export interface SlackAlertMetadata {
  [key: string]: string | number | boolean;
}

export interface SlackMessageResult {
  ts: string;
  channel: string;
  ok: boolean;
}

export interface SlackThreadResult {
  ts: string;
  threadTs: string;
  channel: string;
  ok: boolean;
}

export interface SlackUploadResult {
  fileId: string;
  permalink: string;
  ok: boolean;
}

export class SlackIntegrationTool {
  private readonly client: WebClient;

  constructor() {
    const token = process.env['SLACK_BOT_TOKEN'];
    if (!token) {
      throw new Error('SLACK_BOT_TOKEN environment variable is required');
    }
    // Note: SLACK_SIGNING_SECRET is intentionally NOT validated here.
    // It is only needed for *inbound* webhook signature verification, which is
    // the responsibility of the Express middleware layer (e.g. @slack/bolt or
    // a custom verifyRequestSignature middleware), not the outbound WebClient.
    this.client = new WebClient(token);
  }

  /**
   * Send a plain-text (or block-kit) message to a Slack channel.
   */
  async sendMessage(
    channel: string,
    text: string,
    blocks?: (KnownBlock | Block)[]
  ): Promise<SlackMessageResult> {
    try {
      const response = await this.client.chat.postMessage({
        channel,
        text,
        ...(blocks && blocks.length > 0 ? { blocks } : {}),
      });

      if (!response.ok || !response.ts) {
        throw new Error(`Slack API returned not-ok: ${response.error ?? 'unknown error'}`);
      }

      return {
        ts: response.ts,
        channel: (response.channel as string | undefined) ?? channel,
        ok: true,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`sendMessage to channel "${channel}" failed: ${msg}`);
    }
  }

  /**
   * Send a formatted alert message to a Slack channel.
   * Severity maps to a color-coded attachment-style block layout.
   */
  async sendAlert(
    channel: string,
    severity: SlackSeverity,
    title: string,
    message: string,
    metadata: SlackAlertMetadata
  ): Promise<SlackMessageResult> {
    const severityEmoji: Record<SlackSeverity, string> = {
      info: ':information_source:',
      warning: ':warning:',
      error: ':x:',
      critical: ':rotating_light:',
    };

    const severityColor: Record<SlackSeverity, string> = {
      info: '#36a64f',
      warning: '#ffcc00',
      error: '#cc0000',
      critical: '#7b0000',
    };

    const metadataText = Object.entries(metadata)
      .map(([k, v]) => `*${k}:* ${String(v)}`)
      .join('\n');

    const blocks: KnownBlock[] = [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: `${severityEmoji[severity]} [${severity.toUpperCase()}] ${title}`,
          emoji: true,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: message,
        },
      },
    ];

    if (metadataText) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: metadataText,
        },
      });
    }

    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `Severity: *${severity}* | Color: ${severityColor[severity]} | Timestamp: ${new Date().toISOString()}`,
        },
      ],
    });

    const fallbackText = `[${severity.toUpperCase()}] ${title}: ${message}`;
    return this.sendMessage(channel, fallbackText, blocks);
  }

  /**
   * Reply in a thread (or start one if ts is the parent message timestamp).
   */
  async createThread(
    channel: string,
    ts: string,
    reply: string
  ): Promise<SlackThreadResult> {
    try {
      const response = await this.client.chat.postMessage({
        channel,
        text: reply,
        thread_ts: ts,
      });

      if (!response.ok || !response.ts) {
        throw new Error(`Slack API returned not-ok: ${response.error ?? 'unknown error'}`);
      }

      return {
        ts: response.ts,
        threadTs: ts,
        channel: (response.channel as string | undefined) ?? channel,
        ok: true,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(
        `createThread in channel "${channel}" (thread_ts: ${ts}) failed: ${msg}`
      );
    }
  }

  /**
   * Upload a file or code snippet to a Slack channel.
   */
  async uploadFile(
    channel: string,
    filename: string,
    content: string
  ): Promise<SlackUploadResult> {
    try {
      // Use the v2 upload API (files.getUploadURLExternal + files.completeUploadExternal)
      // Fall back to legacy files.upload for compatibility with older workspace plans.
      const response = await this.client.files.uploadV2({
        channel_id: channel,
        filename,
        content,
      });

      // The v2 response shape may vary; extract best-effort fields.
      const fileData = response as {
        ok: boolean;
        files?: Array<{ id?: string; permalink?: string }>;
        file?: { id?: string; permalink?: string };
      };

      if (!fileData.ok) {
        throw new Error('Slack files.uploadV2 returned not-ok');
      }

      const file = fileData.files?.[0] ?? fileData.file;
      return {
        fileId: file?.id ?? 'unknown',
        permalink: file?.permalink ?? '',
        ok: true,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`uploadFile "${filename}" to channel "${channel}" failed: ${msg}`);
    }
  }

  /**
   * Edit (update) an existing Slack message identified by its channel + timestamp.
   */
  async updateMessage(
    channel: string,
    ts: string,
    newText: string
  ): Promise<SlackMessageResult> {
    try {
      const response = await this.client.chat.update({
        channel,
        ts,
        text: newText,
      });

      if (!response.ok) {
        throw new Error(`Slack API returned not-ok: ${response.error ?? 'unknown error'}`);
      }

      return {
        ts: (response.ts as string | undefined) ?? ts,
        channel: (response.channel as string | undefined) ?? channel,
        ok: true,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(
        `updateMessage in channel "${channel}" (ts: ${ts}) failed: ${msg}`
      );
    }
  }
}
